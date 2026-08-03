// index.js — the renderer's entry point.
//
// index.html loads THIS file, not app.js. The order below is the contract:
//
//   1. app.js first, so its registries (views, dialogs, commands, status items,
//      title-bar actions) are fully initialised before anything reaches for
//      them. Every feature module imports app.js, so importing it anywhere else
//      first would evaluate a module that touches `registerDialog` while
//      app.js's own `const dialogs` is still in its temporal dead zone — a
//      ReferenceError at boot, not a subtle bug.
//
//   2. the feature modules, each of which self-registers on import.
//
//   3. app.js's `boot()` runs on a macrotask (see the tail of app.js), which is
//      after every module body AND after the microtasks several of them defer
//      their registration to. So by the time the shell renders and
//      `shell:ready` fires, the panels, the 301 commands, the queue and all 28
//      dialogs are already in the registries.
//
// Adding a module to the application is one line here. A module that is not
// listed — directly or through another module's imports — is dead code, which
// is the state the whole renderer was in before this file existed.

import './app.js';

// The keyboard route to every registered command and every declared
// Preferences destination. It is imported before boot so its title-bar entry
// and command are present when the shell first renders.
import './ui/commandpalette.js';

// The file panels, the 301-action command layer, the toolbars, the menu bars,
// the column model, the drive tree and the per-panel status bars.
import './ui/panels.js';

// The transfer queue, the progress window and the six transfer/session dialogs
// (overwrite query, synchronize, checklist, authenticate, message, server info).
import './ui/queue.js';

// The seam that points the dialog-heavy actions at the forms.json-complete
// dialogs instead of the command layer's own fallbacks. Pulls in properties,
// rights, create-directory, symlink, remote transfer, the two mask editors,
// bookmarks, location profiles, find, login, site advanced, generate URL,
// import sessions, the console and the internal editor.
import './ui/wiring.js';

// The session log viewer.
import './ui/log.js';

// About (which brings the changelog viewer, the licence and version history),
// Clean up, and Preferences (which brings the transfer presets, the editor list
// and the custom-command editor).
import './ui/dialogs/about.js';
import './ui/dialogs/cleanup.js';
import './ui/dialogs/preferences.js';
