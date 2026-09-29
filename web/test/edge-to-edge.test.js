import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = process.cwd();
const html = readFileSync(join(repoRoot, 'web/index.html'), 'utf8');
const app = readFileSync(join(repoRoot, 'web/app.js'), 'utf8');
const vid = readFileSync(join(repoRoot, 'engine/h2shared/vid_soft_web.c'), 'utf8');
const draw = readFileSync(join(repoRoot, 'engine/h2shared/draw.c'), 'utf8');
const keys = readFileSync(join(repoRoot, 'engine/hexen2/keys.c'), 'utf8');

test('immersive play spends no screen space on safe-area padding', () => {
  const immersiveBody = html.match(
    /body\[data-engine-state="running"\]\[data-immersive="true"\] \{([\s\S]*?)\n {4}\}/,
  )?.[1];
  assert.ok(immersiveBody, 'the immersive body rule exists');
  assert.match(immersiveBody, /padding: 0;/);
  assert.doesNotMatch(immersiveBody, /--safe-/,
    'padding the window for the iOS status bar just trades game pixels for black bars');
  // The overlays inside the viewport still keep clear of the system glyphs.
  assert.match(html, /\.phone-top-button \{[\s\S]*?top: max\(0\.75rem, var\(--safe-top\)\)/);
  assert.match(html, /\.phone-overlay \{[\s\S]*?inset: max\(0\.75rem, var\(--safe-top\)\)/);
});

test('a connected controller replaces the launcher hamburger', () => {
  assert.match(html, /body\[data-gamepad="true"\] #phone-menu-button \{ display: none; \}/);
  assert.match(app, /document\.body\.dataset\.gamepad = state\.gamepadConnected \? 'true' : 'false';/);
  assert.match(app, /addEventListener\('gamepadconnected', \(\) => \{\n\s*state\.gamepadConnected = true;/);
  assert.match(app, /addEventListener\('gamepaddisconnected', \(\) => \{\n\s*state\.gamepadConnected = false;/);
  // Keyboard/mouse activity must not be mistaken for a controller.
  assert.match(app, /state\.gamepadConnected = state\.gamepadConnected \|\| hasConnectedGamepad\(\);/);
});

test('the virtual left stick strafes instead of turning', () => {
  assert.match(keys, /Key_SetBinding \(K_TOUCH_LEFT, "\+moveleft"\);/);
  assert.match(keys, /Key_SetBinding \(K_TOUCH_RIGHT, "\+moveright"\);/);
});

test('the software renderer sizes its framebuffer from the live canvas aspect', () => {
  assert.match(vid, /cvar_t\s+vid_soft_widescreen = \{"vid_soft_widescreen", "1", CVAR_ARCHIVE\}/,
    'edge-to-edge rendering is the default');
  assert.match(vid, /Cvar_RegisterVariable \(&vid_soft_widescreen\);/);

  const modeSize = vid.match(/static void VID_ModeSize \(int mode, int \*width, int \*height\)\n\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(modeSize, 'VID_ModeSize is defined');
  assert.match(modeSize, /aspect = \(float\)canvas_width \/ \(float\)canvas_height;/,
    'the render size follows the canvas, not a fixed 4:3 shape');
  assert.match(modeSize, /if \(w > MAXWIDTH\)/, 'the rasterizer ceiling still binds');
  assert.match(modeSize, /if \(h > MAXHEIGHT\)/);

  // A rung's size now depends on the canvas aspect, so an unchanged rung
  // index no longer means an unchanged framebuffer.
  const checkMode = vid.match(/static void VID_CheckMode \(void\)\n\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(checkMode, 'VID_CheckMode is defined');
  assert.match(checkMode, /width != vid\.width \|\| height != vid\.height/);
});

test('auto mode budgets the widened size and only calls exact upscales exact', () => {
  const autoMode = vid.match(/static int VID_AutoMode \(void\)\n\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(autoMode, 'VID_AutoMode is defined');
  assert.match(autoMode, /VID_ModeSize \(i, &w, &h\);\n\s*if \(w \* h > AUTO_MAX_PIXELS\)/,
    'the frame budget must be spent on the resolution actually rendered');
  assert.match(autoMode, /if \(dh % h == 0 && dw % w == 0\)/,
    'a 6.95x upscale is not an integer upscale');
});

test('whatever the refresh window misses is black, not Hexen II backdrop tile', () => {
  // R_SetVrect rounds the 3D view down to a multiple of 8 pixels wide, so a
  // widescreen framebuffer keeps a couple of columns down each side that only
  // Draw_TileClear ever paints. Scaled up to the panel, the lit brown backtile
  // read as an orange frame around the picture.
  const tileClear = draw.match(/#if defined\(WEBQUAKE\)\nvoid Draw_TileClear \(int x, int y, int w, int h\)\n\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(tileClear, 'the web build has its own Draw_TileClear');
  assert.match(tileClear, /Draw_FillAlpha \(x, y, w, h, 0\.0f, 0\.0f, 0\.0f, 1\.0f\);/);
  assert.doesNotMatch(tileClear, /r_rectdesc|R_DrawRect/, 'the backdrop tile is what we are getting rid of');
  // Draw_Fill honours the global translucency, which the tile never did.
  assert.match(tileClear, /trans_level = 0;[\s\S]*?trans_level = saved;/);
  // The rect is passed in canvas coordinates: Draw_FillAlpha clamps against
  // draw_canvas_x/y and Draw_Fill applies the translation itself.
  assert.doesNotMatch(tileClear, /draw_canvas_/);
});
