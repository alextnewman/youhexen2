#include "quakedef.h"

#include <ctype.h>
#include <math.h>
#include <emscripten/emscripten.h>
#include <emscripten/html5.h>

/* Named "gamepad" (not "in_gamepad") because the Controller Options menu
 * toggles it by name via Cvar_Set("gamepad", ...). */
cvar_t in_gamepad = {"gamepad", "1", CVAR_ARCHIVE};
cvar_t joy_deadzone_look = {"joy_deadzone_look", "0.2", CVAR_ARCHIVE};
cvar_t joy_deadzone_move = {"joy_deadzone_move", "0.2", CVAR_ARCHIVE};
cvar_t joy_deadzone_trigger = {"joy_deadzone_trigger", "0.2", CVAR_ARCHIVE};
cvar_t joy_sensitivity_yaw = {"joy_sensitivity_yaw", "240", CVAR_ARCHIVE};
cvar_t joy_sensitivity_pitch = {"joy_sensitivity_pitch", "180", CVAR_ARCHIVE};
cvar_t joy_exponent = {"joy_exponent", "2", CVAR_ARCHIVE};
cvar_t joy_exponent_move = {"joy_exponent_move", "1.5", CVAR_ARCHIVE};
cvar_t joy_invert = {"joy_invert", "0", CVAR_ARCHIVE};
cvar_t joy_swapmovelook = {"joy_swapmovelook", "0", CVAR_ARCHIVE};
cvar_t joy_rumble = {"joy_rumble", "1", CVAR_ARCHIVE};
cvar_t m_filter = {"m_filter", "1", CVAR_ARCHIVE};
cvar_t _enable_mouse = {"_enable_mouse", "1", CVAR_ARCHIVE};
/* iPad keyboards (Magic Keyboard, Smart Keyboard Folio) have no Escape key,
 * and Hexen II's whole menu system is built around Escape.  With this set,
 * the unshifted backquote acts as Escape and the console moves to Shift+`
 * (i.e. '~'), which is still reachable on every keyboard we care about. */
cvar_t in_key_backquote_escape = {"in_key_backquote_escape", "1", CVAR_ARCHIVE};

/* Menu mouse cursor position, in menu canvas coordinates.  Fed by the
 * pointer callbacks below; consumed by the menu hit-testing code. */
int menu_mouse_x, menu_mouse_y;

/* Gamepad "alt" modifier chord, mirrored from the SDL input backend so
 * keys.c can share its gamepad binding logic. */
qboolean joy_altmodifier_pressed = false;

static double look_x, look_y, gyro_look_x, gyro_look_y;
static qboolean mouse_active;
static qboolean touch_controls_override;
static int cursor_hidden = -1;	/* tri-state: -1 = unknown, 0 = shown, 1 = hidden */

/*
================
Web_SetCursorHidden

The browser cursor is ours to manage: there is no window manager to do it
and no pointer lock on iPadOS Safari.  Hidden during gameplay, shown while
the menu or console owns the keyboard so the launcher chrome and the
overlay buttons stay usable.
================
*/
static void Web_SetCursorHidden (int hidden)
{
	if (cursor_hidden == hidden)
		return;
	cursor_hidden = hidden;
	EM_ASM({
		var canvas = document.getElementById('canvas');
		if (canvas)
			canvas.style.cursor = $0 ? 'none' : 'default';
	}, hidden);
}

static int Web_KeyCode (const EmscriptenKeyboardEvent *event)
{
	const char *key = event->key;
	if (key[0] && !key[1])
		return tolower((unsigned char)key[0]);
	if (!strcmp(key, "Tab")) return K_TAB;
	if (!strcmp(key, "Enter")) return K_ENTER;
	if (!strcmp(key, "Escape")) return K_ESCAPE;
	if (!strcmp(key, " ")) return K_SPACE;
	if (!strcmp(key, "Backspace")) return K_BACKSPACE;
	if (!strcmp(key, "ArrowUp")) return K_UPARROW;
	if (!strcmp(key, "ArrowDown")) return K_DOWNARROW;
	if (!strcmp(key, "ArrowLeft")) return K_LEFTARROW;
	if (!strcmp(key, "ArrowRight")) return K_RIGHTARROW;
	if (!strcmp(key, "Shift")) return K_SHIFT;
	if (!strcmp(key, "Control")) return K_CTRL;
	if (!strcmp(key, "Alt")) return K_ALT;
	if (!strcmp(key, "Delete")) return K_DEL;
	if (!strcmp(key, "Home")) return K_HOME;
	if (!strcmp(key, "End")) return K_END;
	if (!strcmp(key, "PageUp")) return K_PGUP;
	if (!strcmp(key, "PageDown")) return K_PGDN;
	if (key[0] == 'F' && isdigit((unsigned char)key[1]) && !key[3])
	{
		int number = atoi(key + 1);
		if (number >= 1 && number <= 12)
			return K_F1 + number - 1;
	}
	return 0;
}

static EM_BOOL Web_KeyboardCallback (int event_type,
	const EmscriptenKeyboardEvent *event, void *user_data)
{
	int key = Web_KeyCode(event);
	qboolean escaped;
	(void)user_data;
	if (!key)
		return EM_FALSE;
	/* '`' becomes Escape; Shift+'`' ('~') keeps toggling the console. */
	escaped = (key == '`' && in_key_backquote_escape.integer) ? true : false;
	if (escaped)
		key = K_ESCAPE;
	Key_Event(key, event_type == EMSCRIPTEN_EVENT_KEYDOWN);
	if (!escaped && event_type == EMSCRIPTEN_EVENT_KEYDOWN && event->key[0] && !event->key[1] &&
		event->key[0] >= 32 && event->key[0] < 127)
		Key_CharEvent(event->key);
	return EM_TRUE;
}

static EM_BOOL Web_MouseCallback (int event_type,
	const EmscriptenMouseEvent *event, void *user_data)
{
	int key;
	(void)user_data;
	if (event_type == EMSCRIPTEN_EVENT_MOUSEMOVE)
	{
		if (mouse_active)
		{
			look_x += event->movementX;
			look_y += event->movementY;
		}
		return EM_TRUE;
	}
	key = event->button == 0 ? K_MOUSE1 :
		(event->button == 1 ? K_MOUSE3 : K_MOUSE2);
	Key_Event(key, event_type == EMSCRIPTEN_EVENT_MOUSEDOWN);
	return EM_TRUE;
}

static EM_BOOL Web_WheelCallback (int event_type,
	const EmscriptenWheelEvent *event, void *user_data)
{
	int key = event->deltaY < 0 ? K_MWHEELUP : K_MWHEELDOWN;
	(void)event_type;
	(void)user_data;
	Key_Event(key, true);
	Key_Event(key, false);
	return EM_TRUE;
}

static int Web_TouchKeyForMenu (int key)
{
	if (!(Key_GetDest() & key_menu))
		return key;

	switch (key)
	{
	case 'w':
	case 'W':
	case K_TOUCH_FORWARD:
		return K_GP_DPAD_UP;
	case 's':
	case 'S':
	case K_TOUCH_BACK:
		return K_GP_DPAD_DOWN;
	case 'a':
	case 'A':
	case K_TOUCH_LEFT:
		return K_GP_DPAD_LEFT;
	case 'd':
	case 'D':
	case K_TOUCH_RIGHT:
		return K_GP_DPAD_RIGHT;
	default:
		return key;
	}
}

/* A touch can outlive a menu transition. Remember the key emitted on press so
 * its release cannot be translated for the new destination and leave the
 * original gameplay or menu key stuck down. */
static int	touch_key_down[MAX_KEYS];

EMSCRIPTEN_KEEPALIVE int Web_TouchKey (int key, int down)
{
	int mapped;

	if (key < 0 || key >= MAX_KEYS)
		return 0;
	if (down)
	{
		if (touch_key_down[key])
			return 1;
		mapped = Web_TouchKeyForMenu(key);
		touch_key_down[key] = mapped;
		Key_Event(mapped, true);
	}
	else if (touch_key_down[key])
	{
		Key_Event(touch_key_down[key], false);
		touch_key_down[key] = 0;
	}
	return 1;
}

EMSCRIPTEN_KEEPALIVE void Web_TouchLook (double dx, double dy)
{
	look_x += dx;
	look_y += dy;
}

EMSCRIPTEN_KEEPALIVE void Web_GyroLook (double dx, double dy)
{
	gyro_look_x += dx;
	gyro_look_y += dy;
}

EMSCRIPTEN_KEEPALIVE void Web_TouchControlsVisible (int visible)
{
	touch_controls_override = visible ? true : false;
}

/* Write cvars and key bindings to config.cfg in the runtime filesystem
 * without quitting. The launcher calls this on lifecycle paths that bypass
 * the in-game Quit menu (return-to-launcher, page hide) so settings survive
 * a tab close or PWA suspend that never runs Host_Shutdown. */
EMSCRIPTEN_KEEPALIVE void Web_FlushConfig (void)
{
	Host_WriteConfiguration ("config.cfg");
}

static qboolean Web_GamepadEnabled (void)
{
	return in_gamepad.integer || touch_controls_override;
}

/*
================================================================

Gamepad -- native W3C Gamepad API driver

The web platform has no SDL joystick layer to lean on, so this is a
first-party driver over the browser's Gamepad API (sampled through
Emscripten's HTML5 bindings).  The browser hands us the "standard
gamepad" layout directly -- a fixed button/axis order that every
controller iPadOS pairs with (MFi, Xbox, DualSense, Switch Pro) reports
-- so the mapping below is a plain index table rather than a translation
of somebody else's controller database.

Unlike the mouse path there is no event stream: the Gamepad API is
poll-only, so Web_PollGamepad() runs once per host frame from
IN_Commands() and turns level state into the engine's edge-triggered
Key_Event() calls itself.

================================================================
*/

/* W3C "standard gamepad" button indices. */
enum {
	GPB_A = 0, GPB_B, GPB_X, GPB_Y,
	GPB_LSHOULDER, GPB_RSHOULDER,
	GPB_LTRIGGER, GPB_RTRIGGER,
	GPB_BACK, GPB_START,
	GPB_LTHUMB, GPB_RTHUMB,
	GPB_DPAD_UP, GPB_DPAD_DOWN, GPB_DPAD_LEFT, GPB_DPAD_RIGHT,
	GPB_GUIDE,
	GPB_COUNT
};

/* W3C "standard gamepad" axis indices. */
#define GPA_LEFTX	0
#define GPA_LEFTY	1
#define GPA_RIGHTX	2
#define GPA_RIGHTY	3

static const int gp_button_keys[GPB_COUNT] = {
	K_GP_A, K_GP_B, K_GP_X, K_GP_Y,
	K_GP_LSHOULDER, K_GP_RSHOULDER,
	K_GP_LTRIGGER, K_GP_RTRIGGER,
	K_GP_BACK, K_GP_START,
	K_GP_LTHUMB, K_GP_RTHUMB,
	K_GP_DPAD_UP, K_GP_DPAD_DOWN, K_GP_DPAD_LEFT, K_GP_DPAD_RIGHT,
	0	/* guide/home: claimed by the OS on iPadOS, left unbound */
};

/* Menu/console navigation synthesised from the D-pad and the move stick. */
enum { GPNAV_LEFT = 0, GPNAV_RIGHT, GPNAV_UP, GPNAV_DOWN, GPNAV_COUNT };
static const int gp_nav_keys[GPNAV_COUNT] = {
	K_LEFTARROW, K_RIGHTARROW, K_UPARROW, K_DOWNARROW
};
#define GP_NAV_THRESHOLD	0.5
#define GP_NAV_REPEAT_DELAY	0.4
#define GP_NAV_REPEAT_RATE	0.12

typedef struct {
	double	x, y;
} gpstick_t;

static int		gp_index = -1;		/* browser gamepad slot, -1 = none */
static gamepad_type_t	gp_type = GAMEPAD_TYPE_UNKNOWN;
static int		gp_button_key[GPB_COUNT];	/* key emitted while held, 0 = up */
static qboolean		gp_nav_down[GPNAV_COUNT];
static double		gp_nav_repeat[GPNAV_COUNT];
static gpstick_t	gp_move, gp_look;
static gpstick_t	touch_move;	/* analog vector from the touch stick */

/* Analog vector from the touch stick, -1..1 per axis, y positive = pull
 * toward the player. Set on change; the launcher zeroes it on release. */
EMSCRIPTEN_KEEPALIVE void Web_TouchMove (double x, double y)
{
	touch_move.x = x;
	touch_move.y = y;
}

static qboolean Web_StrContainsNoCase (const char *haystack, const char *needle)
{
	size_t i, hlen = strlen(haystack), nlen = strlen(needle);

	if (!nlen)
		return true;
	if (hlen < nlen)
		return false;
	for (i = 0; i + nlen <= hlen; i++)
	{
		if (!q_strncasecmp(haystack + i, needle, nlen))
			return true;
	}
	return false;
}

/* The Gamepad API exposes no controller class, only the vendor id string,
 * so brand detection (used for menu button glyphs) is a name match. */
static gamepad_type_t Web_GPClassify (const char *id)
{
	if (Web_StrContainsNoCase(id, "xbox") || Web_StrContainsNoCase(id, "xinput"))
		return GAMEPAD_TYPE_XBOX;
	if (Web_StrContainsNoCase(id, "dualsense") ||
	    Web_StrContainsNoCase(id, "dualshock") ||
	    Web_StrContainsNoCase(id, "playstation") ||
	    Web_StrContainsNoCase(id, "054c"))	/* Sony USB vendor id */
		return GAMEPAD_TYPE_PLAYSTATION;
	if (Web_StrContainsNoCase(id, "nintendo") ||
	    Web_StrContainsNoCase(id, "switch") ||
	    Web_StrContainsNoCase(id, "joy-con") ||
	    Web_StrContainsNoCase(id, "joycon") ||
	    Web_StrContainsNoCase(id, "057e"))	/* Nintendo USB vendor id */
		return GAMEPAD_TYPE_NINTENDO_SWITCH;
	return GAMEPAD_TYPE_UNKNOWN;
}

/* circular deadzone: rescales the vector so magnitude runs [0,1] once it
 * clears the deadzone, which keeps diagonals from feeling faster. */
static gpstick_t Web_GPDeadzone (double x, double y, double deadzone)
{
	gpstick_t	result = {0, 0};
	double		mag = sqrt(x*x + y*y);
	double		scale;

	if (deadzone < 0)
		deadzone = 0;
	if (deadzone > 0.9)
		deadzone = 0.9;
	if (mag <= deadzone)
		return result;

	scale = (mag - deadzone) / (1.0 - deadzone) / mag;
	if (scale * mag > 1.0)
		scale = 1.0 / mag;
	result.x = x * scale;
	result.y = y * scale;
	return result;
}

/* power curve on the magnitude, direction preserved */
static gpstick_t Web_GPEase (gpstick_t in, double exponent)
{
	gpstick_t	result = {0, 0};
	double		mag = sqrt(in.x*in.x + in.y*in.y);
	double		scale;

	if (mag < 0.001)
		return result;
	if (exponent < 1.0)
		exponent = 1.0;
	scale = pow(mag > 1.0 ? 1.0 : mag, exponent) / mag;
	result.x = in.x * scale;
	result.y = in.y * scale;
	return result;
}

/*
================
Web_GPKeyForButton

Which engine key a physical button stands for right now.  In menus and
the console the D-pad is consumed by the navigation repeat below (so it
must not also fire its in-game keycode) and the triggers double as
"confirm", so a controller alone can drive the whole UI.  key_menubind
counts as game input on purpose: that is the screen where the raw
K_GP_* codes have to reach keys.c to be bound.
================
*/
static int Web_GPKeyForButton (int index, qboolean gamekey)
{
	if (!gamekey)
	{
		switch (index)
		{
		case GPB_DPAD_UP:
		case GPB_DPAD_DOWN:
		case GPB_DPAD_LEFT:
		case GPB_DPAD_RIGHT:
			return 0;
		case GPB_LTRIGGER:
		case GPB_RTRIGGER:
			return K_ENTER;
		default:
			break;
		}
	}
	return gp_button_keys[index];
}

/* Remembers the key that was emitted on press and releases that same key,
 * so a button held across a menu transition can never get stuck down. */
static void Web_GPButton (int index, qboolean down, qboolean gamekey)
{
	if (down)
	{
		int key;
		if (gp_button_key[index])
			return;
		key = Web_GPKeyForButton(index, gamekey);
		if (!key)
			return;
		gp_button_key[index] = key;
		Key_Event(key, true);
	}
	else if (gp_button_key[index])
	{
		Key_Event(gp_button_key[index], false);
		gp_button_key[index] = 0;
	}
}

/* Menus have long lists (saves, key bindings), so held navigation has to
 * repeat.  Re-sending the keydown is what the engine expects: Key_Event
 * counts the repeats and M_Keydown allows them for navigation keys. */
static void Web_GPNav (int slot, qboolean down)
{
	if (!down)
	{
		if (gp_nav_down[slot])
		{
			gp_nav_down[slot] = false;
			Key_Event(gp_nav_keys[slot], false);
		}
		return;
	}
	if (!gp_nav_down[slot])
	{
		gp_nav_down[slot] = true;
		gp_nav_repeat[slot] = realtime + GP_NAV_REPEAT_DELAY;
		Key_Event(gp_nav_keys[slot], true);
	}
	else if (realtime >= gp_nav_repeat[slot])
	{
		gp_nav_repeat[slot] = realtime + GP_NAV_REPEAT_RATE;
		Key_Event(gp_nav_keys[slot], true);
	}
}

static void Web_GPForget (void)
{
	int	i;

	for (i = 0; i < GPB_COUNT; i++)
		gp_button_key[i] = 0;
	for (i = 0; i < GPNAV_COUNT; i++)
	{
		gp_nav_down[i] = false;
		gp_nav_repeat[i] = 0;
	}
	gp_move.x = gp_move.y = gp_look.x = gp_look.y = 0;
}

static void Web_GPReleaseAll (void)
{
	int	i;

	for (i = 0; i < GPB_COUNT; i++)
		Web_GPButton(i, false, false);
	for (i = 0; i < GPNAV_COUNT; i++)
		Web_GPNav(i, false);
	Web_GPForget();
}

static void Web_GPDisconnect (void)
{
	if (gp_index >= 0)
		Con_Printf("Gamepad disconnected\n");
	Web_GPReleaseAll();
	gp_index = -1;
	gp_type = GAMEPAD_TYPE_UNKNOWN;
}

/*
================
Web_SelectGamepad

Keeps the current pad if it is still present, otherwise adopts the first
connected one.  Standard-mapping pads win over anything else, because the
index table above is only meaningful for them.
================
*/
static qboolean Web_SelectGamepad (int num_pads, EmscriptenGamepadEvent *state)
{
	int	i, fallback = -1;

	if (gp_index >= 0 && gp_index < num_pads &&
	    emscripten_get_gamepad_status(gp_index, state) == EMSCRIPTEN_RESULT_SUCCESS &&
	    state->connected)
		return true;

	if (gp_index >= 0)
		Web_GPDisconnect();

	for (i = 0; i < num_pads; i++)
	{
		if (emscripten_get_gamepad_status(i, state) != EMSCRIPTEN_RESULT_SUCCESS)
			continue;
		if (!state->connected)
			continue;
		if (!strcmp(state->mapping, "standard"))
			break;
		if (fallback < 0)
			fallback = i;
	}
	if (i >= num_pads)
	{
		if (fallback < 0)
			return false;
		i = fallback;
		if (emscripten_get_gamepad_status(i, state) != EMSCRIPTEN_RESULT_SUCCESS)
			return false;
	}

	gp_index = i;
	gp_type = Web_GPClassify(state->id);
	Con_Printf("Gamepad connected: \"%s\"%s\n", state->id,
		strcmp(state->mapping, "standard") ? " (non-standard mapping)" : "");
	return true;
}

/*
================
Web_PollGamepad

Once per host frame: sample the browser's gamepad snapshot, turn buttons
and triggers into key events, and stash the filtered stick vectors for
IN_Move().  Menu navigation is emitted here too, because host.c only
calls IN_Move() while the game owns the keyboard.
================
*/
static void Web_PollGamepad (void)
{
	static EmscriptenGamepadEvent	state;
	int		i, num_pads;
	qboolean	gamekey;
	double		nav_x, nav_y;
	gpstick_t	move_raw, look_raw;
	double		ltrig, rtrig;

	if (!Web_GamepadEnabled())
	{
		if (gp_index >= 0)
			Web_GPDisconnect();
		return;
	}

	if (emscripten_sample_gamepad_data() != EMSCRIPTEN_RESULT_SUCCESS)
	{
		if (gp_index >= 0)
			Web_GPDisconnect();
		return;		/* browser has no Gamepad API */
	}

	num_pads = emscripten_get_num_gamepads();
	if (num_pads <= 0)
	{
		if (gp_index >= 0)
			Web_GPDisconnect();
		return;
	}
	/* Web_SelectGamepad has already disconnected the old pad if it failed. */
	if (!Web_SelectGamepad(num_pads, &state))
		return;

	gamekey = Key_IsGameKey();

	/* triggers are analog buttons in the standard mapping */
	ltrig = (state.numButtons > GPB_LTRIGGER) ? state.analogButton[GPB_LTRIGGER] : 0;
	rtrig = (state.numButtons > GPB_RTRIGGER) ? state.analogButton[GPB_RTRIGGER] : 0;

	for (i = 0; i < GPB_COUNT; i++)
	{
		qboolean down;
		if (i >= state.numButtons)
			down = false;
		else if (i == GPB_LTRIGGER)
			down = (ltrig > joy_deadzone_trigger.value);
		else if (i == GPB_RTRIGGER)
			down = (rtrig > joy_deadzone_trigger.value);
		else
			down = state.digitalButton[i] ? true : false;
		Web_GPButton(i, down, gamekey);
	}

	if (state.numAxes > GPA_RIGHTY)
	{
		if (joy_swapmovelook.integer)
		{
			look_raw.x = state.axis[GPA_LEFTX];
			look_raw.y = state.axis[GPA_LEFTY];
			move_raw.x = state.axis[GPA_RIGHTX];
			move_raw.y = state.axis[GPA_RIGHTY];
		}
		else
		{
			move_raw.x = state.axis[GPA_LEFTX];
			move_raw.y = state.axis[GPA_LEFTY];
			look_raw.x = state.axis[GPA_RIGHTX];
			look_raw.y = state.axis[GPA_RIGHTY];
		}
	}
	else
	{
		move_raw.x = move_raw.y = look_raw.x = look_raw.y = 0;
	}

	gp_move = Web_GPEase(Web_GPDeadzone(move_raw.x, move_raw.y,
				joy_deadzone_move.value), joy_exponent_move.value);
	gp_look = Web_GPEase(Web_GPDeadzone(look_raw.x, look_raw.y,
				joy_deadzone_look.value), joy_exponent.value);

	if (gamekey)
	{
		for (i = 0; i < GPNAV_COUNT; i++)
			Web_GPNav(i, false);
		return;
	}

	/* Menu navigation is intentionally D-pad-only: a stick makes it too easy
	 * to send accidental cursor drift while browsing options and inventories. */
	nav_x = 0;
	nav_y = 0;
	if (GPB_DPAD_LEFT < state.numButtons && state.digitalButton[GPB_DPAD_LEFT])
		nav_x = -1;
	if (GPB_DPAD_RIGHT < state.numButtons && state.digitalButton[GPB_DPAD_RIGHT])
		nav_x = 1;
	if (GPB_DPAD_UP < state.numButtons && state.digitalButton[GPB_DPAD_UP])
		nav_y = -1;
	if (GPB_DPAD_DOWN < state.numButtons && state.digitalButton[GPB_DPAD_DOWN])
		nav_y = 1;

	Web_GPNav(GPNAV_LEFT, nav_x <= -GP_NAV_THRESHOLD);
	Web_GPNav(GPNAV_RIGHT, nav_x >= GP_NAV_THRESHOLD);
	Web_GPNav(GPNAV_UP, nav_y <= -GP_NAV_THRESHOLD);
	Web_GPNav(GPNAV_DOWN, nav_y >= GP_NAV_THRESHOLD);

	/* Keep the stick for gameplay only; menu nav is resolved from the D-pad. */
	gp_move.x = gp_move.y = gp_look.x = gp_look.y = 0;
}

static void Web_GPMove (usercmd_t *cmd)
{
	float	speed;

	if (gp_index < 0)
		return;
	if (gp_move.x == 0 && gp_move.y == 0 && gp_look.x == 0 && gp_look.y == 0)
		return;

	speed = (in_speed.state & 1) ? cl_movespeedkey.value : 1;

	cmd->sidemove += gp_move.x * speed * 225;
	cmd->forwardmove -= gp_move.y * speed * 200;

	if (gp_look.x != 0 || gp_look.y != 0)
	{
		cl.viewangles[YAW] -= gp_look.x * joy_sensitivity_yaw.value * host_frametime;
		cl.viewangles[PITCH] += gp_look.y * joy_sensitivity_pitch.value *
					host_frametime * (joy_invert.integer ? -1.0f : 1.0f);
		cl.viewangles[PITCH] = q_max(-70, q_min(80, cl.viewangles[PITCH]));
		V_StopPitchDrift();
	}
}

static void Web_GPAltModifierDown (void) { joy_altmodifier_pressed = true; }
static void Web_GPAltModifierUp (void) { joy_altmodifier_pressed = false; }

qboolean IN_HasGamepad (void) { return gp_index >= 0; }
gamepad_type_t IN_GetGamepadType (void) { return gp_type; }

/*
================
IN_GPRumble

Gamepad API haptics.  Not implemented by every browser (Safari has no
vibrationActuator today), so this is strictly best-effort and guarded.
================
*/
void IN_GPRumble (float low_freq, float high_freq, unsigned int duration_ms)
{
	double	strong, weak;

	if (gp_index < 0 || joy_rumble.value <= 0)
		return;
	if (duration_ms > 5000)
		duration_ms = 5000;
	strong = (double)low_freq * (double)joy_rumble.value;
	weak = (double)high_freq * (double)joy_rumble.value;
	strong = q_max(0.0, q_min(1.0, strong));
	weak = q_max(0.0, q_min(1.0, weak));

	EM_ASM({
		try {
			var pads = navigator.getGamepads ? navigator.getGamepads() : [];
			var pad = pads && pads[$0];
			var actuator = pad && (pad.vibrationActuator ||
				(pad.hapticActuators && pad.hapticActuators[0]));
			if (actuator && actuator.playEffect)
				actuator.playEffect('dual-rumble', {
					duration: $3,
					strongMagnitude: $1,
					weakMagnitude: $2
				});
		} catch (e) { /* haptics are optional */ }
	}, gp_index, strong, weak, (double)duration_ms);
}

static void Web_SetTouchMenuMode (int menu)
{
	EM_ASM({
		const menu = Boolean($0);
		queueMicrotask(() => dispatchEvent(new CustomEvent('hexenwailtouchmode',
			{ detail: { menu } })));
	}, menu);
}

void IN_Init (void)
{
	Cvar_RegisterVariable(&in_gamepad);
	Cvar_RegisterVariable(&joy_deadzone_look);
	Cvar_RegisterVariable(&joy_deadzone_move);
	Cvar_RegisterVariable(&joy_deadzone_trigger);
	Cvar_RegisterVariable(&joy_sensitivity_yaw);
	Cvar_RegisterVariable(&joy_sensitivity_pitch);
	Cvar_RegisterVariable(&joy_exponent);
	Cvar_RegisterVariable(&joy_exponent_move);
	Cvar_RegisterVariable(&joy_invert);
	Cvar_RegisterVariable(&joy_swapmovelook);
	Cvar_RegisterVariable(&joy_rumble);
	Cvar_RegisterVariable(&m_filter);
	Cvar_RegisterVariable(&_enable_mouse);
	Cvar_RegisterVariable(&in_key_backquote_escape);
	Cmd_AddCommand("+altmodifier", Web_GPAltModifierDown);
	Cmd_AddCommand("-altmodifier", Web_GPAltModifierUp);
	emscripten_set_keydown_callback(EMSCRIPTEN_EVENT_TARGET_WINDOW, NULL, true,
		Web_KeyboardCallback);
	emscripten_set_keyup_callback(EMSCRIPTEN_EVENT_TARGET_WINDOW, NULL, true,
		Web_KeyboardCallback);
	emscripten_set_mousedown_callback("#canvas", NULL, true, Web_MouseCallback);
	emscripten_set_mouseup_callback(EMSCRIPTEN_EVENT_TARGET_WINDOW, NULL, true,
		Web_MouseCallback);
	emscripten_set_mousemove_callback(EMSCRIPTEN_EVENT_TARGET_WINDOW, NULL, true,
		Web_MouseCallback);
	emscripten_set_wheel_callback("#canvas", NULL, true, Web_WheelCallback);
	mouse_active = true;
}

void IN_ReInit (void) {}
void IN_Shutdown (void) { mouse_active = false; Web_GPForget(); Web_SetCursorHidden(0); }
/* Called once per host frame: the only reliable place to keep the browser
 * cursor in step with what the engine is doing, and -- since the Gamepad
 * API is poll-only -- to sample the controller. */
void IN_Commands (void)
{
	static int	touch_menu = -1;
	int		menu = (Key_GetDest() & key_menu) ? 1 : 0;

	Web_SetCursorHidden(Key_GetDest() == key_game ? 1 : 0);
	if (menu != touch_menu)
	{
		touch_menu = menu;
		Web_SetTouchMenuMode(menu);
	}
	Web_PollGamepad();
}
void IN_SendKeyEvents (void) {}
/* Releases whatever the pad was holding rather than forgetting it: the only
 * in-tree caller (ClearAllStates) drops the engine's keys first, but a silent
 * forget would leave a key stuck down for any caller that does not. */
void IN_ClearStates (void)
{
	look_x = look_y = gyro_look_x = gyro_look_y = 0;
	touch_move.x = touch_move.y = 0;
	memset(touch_key_down, 0, sizeof(touch_key_down));
	Web_GPReleaseAll();
}
void IN_ActivateMouse (void) { mouse_active = true; }
void IN_DeactivateMouse (void) { mouse_active = false; }
void IN_ShowMouse (void) { Web_SetCursorHidden(0); }
void IN_HideMouse (void) { Web_SetCursorHidden(1); }
void IN_UpdateViewAngles (void) {}

void IN_Move (usercmd_t *cmd)
{
	double dx = look_x * sensitivity.value;
	double dy = look_y * sensitivity.value;
	double gyro_dx = gyro_look_x;
	double gyro_dy = gyro_look_y;
	look_x = look_y = 0;
	gyro_look_x = gyro_look_y = 0;
	if (cl.v.cameramode)
		return;
	if ((in_strafe.state & 1) || (lookstrafe.integer && (in_mlook.state & 1)))
		cmd->sidemove += m_side.value * dx;
	else
		cl.viewangles[YAW] -= m_yaw.value * dx;
	if ((in_mlook.state & 1) && !(in_strafe.state & 1))
	{
		V_StopPitchDrift();
		cl.viewangles[PITCH] += m_pitch.value * dy;
		cl.viewangles[PITCH] = q_max(-70, q_min(80, cl.viewangles[PITCH]));
	}
	else
		cmd->forwardmove -= m_forward.value * dy;

	/* Gyro pitch owns its inversion independently. In particular, the
	 * controller menu's joy_invert and the mouse's signed m_pitch must not
	 * silently reverse a motion sensor. */
	if (gyro_dx != 0 || gyro_dy != 0)
	{
		cl.viewangles[YAW] -= m_yaw.value * gyro_dx;
		cl.viewangles[PITCH] += fabs(m_pitch.value) * gyro_dy;
		cl.viewangles[PITCH] = q_max(-70, q_min(80, cl.viewangles[PITCH]));
		V_StopPitchDrift();
	}

	Web_GPMove(cmd);

	/* Touch stick: the analog vector replaces both the direction keys and
	 * the speed key. Full deflection is run (the digital +alwaysrun
	 * equivalent), half deflection is walk — the thumb is the speed
	 * control, so in_speed is deliberately not consulted. */
	if (touch_move.x != 0 || touch_move.y != 0)
	{
		cmd->sidemove += touch_move.x * 225 * cl_movespeedkey.value;
		cmd->forwardmove -= touch_move.y * 200 * cl_movespeedkey.value;
	}
}
