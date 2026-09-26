/*
 * Hexen II adapter: action→keycode map for the virtual-console touch
 * surface (web/lib/phone-controls.js).
 *
 * The toolbox speaks actions; this module is the per-engine half of the
 * contract. Another engine reuses the toolbox unchanged and ships its own
 * keymap in the same shape.
 */

export const HEXEN_TOUCH_KEYCODES = Object.freeze({
  /* The touch surface is a dedicated reserved control surface that never
   * shares the normal gamepad/keyboard binding namespace. The engine
   * treats them as fixed-function keys, so rebinding a real device cannot
   * change them. */
  forward: 272, // K_TOUCH_FORWARD
  back: 273, // K_TOUCH_BACK
  left: 274, // K_TOUCH_LEFT
  right: 275, // K_TOUCH_RIGHT
  attack: 276, // K_TOUCH_ATTACK
  jump: 277, // K_TOUCH_JUMP
  use: 278, // K_TOUCH_USE
  menu: 279, // K_TOUCH_MENU
  menuBack: 280, // K_TOUCH_MENU_BACK
  menuSelect: 281, // K_TOUCH_MENU_SELECT
  nextWeapon: 282, // K_TOUCH_NEXT_WEAPON
  prevWeapon: 283, // K_TOUCH_PREV_WEAPON
});
