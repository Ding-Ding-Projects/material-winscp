// ui/dialogs/login.js — Login / Site Manager (Login.dfm).
//
// The left half is the site tree (ui/dialogs/sitetree.js); the right half is
// the session form; the Tools and Manage menus carry every entry the original
// ActionList defines, and every one of them does the thing it says.
//
// PASSWORDS. main replaces a stored password with the sentinel '__stored__'
// before it crosses the bridge, so this window never holds one it did not just
// receive from the user's own keystrokes. The consequences, all deliberate:
//
//   * the password box is empty with "(unchanged)" beside it when a password
//     is stored, and only a value the user actually typed is sent back;
//   * the working copy's secret fields are wiped the moment the form is
//     submitted or the site is switched, so nothing lingers in renderer state;
//   * nothing here ever logs, echoes, exports or measures a secret — not its
//     value, not its length. "Open in PuTTY" deliberately does NOT pass -pw,
//     because a command line is visible to every process on the machine.
//
// Reference: vendor/winscp/source/forms/Login.{dfm,cpp}.

import {
  h, icon, clear, uid, appearanceTarget, announce, openModal, oneLine,
  copyText, downloadText,
} from '../../dom.js';
import { t, bindText, bindRender } from '../../i18n.js';
import { api, bus, store, persistCurrent, session as appSession } from '../../state.js';
import {
  registerDialog, openDialog, runCommand, registerCommand, registerTitlebarAction,
} from '../../app.js';
import { notify } from '../notifications.js';
import { attachMenuButton, SEPARATOR } from '../contextmenu.js';
import { colorSwatchButton } from '../colorpicker.js';
import { createSearchBar } from '../searchbar.js';
import {
  SESSION_DEFAULTS, SECRET_FIELDS, SECRET_SENTINEL, PROTOCOLS, protocolInfo, s,
  encryptionOptions, defaultPortFor, fieldVisibility, isAnonymous, newSiteData,
  normalizeSite, siteLabel, siteSummary, siteStore, notifySitesChanged,
  installSessionDialogStyles, stripSecrets, createSiteTree, SITE_SEARCH_MODES,
  DEFAULT_SITE_SEARCH_MODE, ANONYMOUS_USER, ANONYMOUS_PASSWORD,
} from './sitetree.js';
import { createSiteAdvancedPanel } from './siteadvanced.js';
import {
  buildSessionUrl, parseSessionUrl, siteFromParsedUrl, openGenerateUrl,
} from './generateurl.js';
import { openImportSessions } from './importsessions.js';

/** Where the site-search mode is remembered between sessions. */
const SEARCH_MODE_PATH = 'search.siteSearchMode';

function storedSearchMode() {
  const all = store.get('search') || {};
  return SITE_SEARCH_MODES.some((m) => m.id === all.siteSearchMode)
    ? all.siteSearchMode : DEFAULT_SITE_SEARCH_MODE;
}

function rememberSearchMode(mode) {
  store.set('search', { ...(store.get('search') || {}), siteSearchMode: mode });
  persistCurrent('search');
  void SEARCH_MODE_PATH;
}

/* ================================================================== */
/* the panel                                                           */
/* ================================================================== */

/**
 * createLoginPanel(opts) -> handle
 *
 * opts:
 *   onLogin(sessionInfo)   a session opened successfully
 *   onClose()              the Close button
 *   prefs                  the preferences document, for the rules that need it
 */
export function createLoginPanel(opts = {}) {
  installSessionDialogStyles();

  const state = {
    /** The working copy the form edits. Never the stored record itself. */
    site: newSiteData(),
    /** The stored site this working copy came from, or null for New Site. */
    sourceId: null,
    /** Secret fields the user has retyped in this editing session. */
    touchedSecrets: new Set(),
    editing: false,
    dirty: false,
    /** True once the user has operated the Save-password box themselves. */
    savePasswordExplicit: false,
    prefs: opts.prefs || {},
  };

  /** The live Save-password checkbox, so the password field can keep it true. */
  let savePasswordBox = null;
  function syncSavePasswordBox() {
    if (savePasswordBox && savePasswordBox.isConnected) {
      savePasswordBox.checked = !!state.site.savePassword;
    }
  }

  /* ---------------- the tree ---------------- */

  const tree = createSiteTree({
    searchMode: storedSearchMode(),
    onSelect: (node) => loadNode(node),
    onActivate: (node) => { loadNode(node); doLogin(); },
    onSearchModeChanged: rememberSearchMode,
    onChanged: () => renderForm(),
    contextItems: (node) => manageMenuItems(node),
    confirm: openConfirm,
    prompt: openPrompt,
  });

  const filterBar = createSearchBar({
    id: 'login-sites',
    labelKey: 'searchSites',
    placeholderKey: 'searchSites',
    appearanceKey: 'search-login-sites',
    appearanceLabel: 'Site list search',
    sampleProvider: () => tree.data.sites.map((s) => `${s.name}\t${s.hostName}\t${s.userName}\t${s.note || ''}`).join('\n'),
    // In plain-text mode the tree filters with the active WinSCP match mode;
    // in regex mode the bar's own predicate takes over, so switching the .*
    // chip narrows the list rather than quietly clearing the filter.
    onChange: (snapshot) => {
      const regex = snapshot.mode === 'regex' && snapshot.pattern;
      tree.setFilter(regex ? snapshot.pattern : snapshot.query, regex ? snapshot.predicate : null);
    },
  });

  // The regex builder answers "find anything matching a pattern"; WinSCP's own
  // three modes answer "find a site the way I remember it". Both are offered,
  // and the mode chip says which one the tree is using.
  const modeChip = h('button', {
    type: 'button', class: 'chip',
    'aria-haspopup': 'menu',
  }, icon('manage_search', 13), h('span', {}, ''));
  attachMenuButton(modeChip, () => SITE_SEARCH_MODES.map((m) => ({
    label: m.label, checked: tree.searchMode === m.id, radio: true,
    onSelect: () => { tree.setSearchMode(m.id); paintModeChip(); },
  })), { label: t('searchSites'), placement: 'bottom-start' });
  function paintModeChip() {
    const mode = SITE_SEARCH_MODES.find((m) => m.id === tree.searchMode);
    modeChip.querySelector('span').textContent = mode ? mode.label : '';
    modeChip.title = `${t('searchSites')}: ${mode ? mode.label : ''}`;
  }
  paintModeChip();

  const toolsBtn = h('button', { type: 'button', class: 'btn-text', 'aria-haspopup': 'menu' },
    icon('tune', 16), h('span', {}, t('tools')), icon('arrow_drop_down', 14));
  attachMenuButton(toolsBtn, () => toolsMenuItems(), { label: t('tools'), placement: 'top-start' });
  appearanceTarget(toolsBtn, 'login-tools-button', 'Tools menu button');

  const manageBtn = h('button', { type: 'button', class: 'btn-text', 'aria-haspopup': 'menu' },
    icon('settings', 16), h('span', {}, t('manage')), icon('arrow_drop_down', 14));
  attachMenuButton(manageBtn, () => manageMenuItems(tree.selected), { label: t('manage'), placement: 'top-start' });
  appearanceTarget(manageBtn, 'login-manage-button', 'Manage menu button');

  /**
   * Starting a site had exactly one entry point: the first row of the tree.
   *
   * That is faithful to WinSCP, which also puts New Site at the top of the list
   * and offers no button — but faithful is not the same as findable. The row
   * carries no affordance saying it is the way to begin, and a user who has
   * saved a few sites reads the whole list as *saved sites*, so the one row
   * that is really a command looks like an entry they have not made yet.
   *
   * The row is untouched. This is a second, labelled way to reach it, which is
   * what the tree's own `add` icon has been promising all along.
   */
  const newSiteBtn = h('button', { type: 'button', class: 'btn-tonal' },
    icon('add', 16), h('span', {}, t('newSite')));
  newSiteBtn.addEventListener('click', () => {
    // select() re-runs onSelect even when the node is already current, so this
    // is also "start over" when a half-filled new site is on screen — the same
    // thing Manage ▸ Reset does, one click closer.
    tree.select('new-site');
    tree.focusSelected();
  });
  appearanceTarget(newSiteBtn, 'login-new-site-button', 'New Site button');

  const left = h('div', { class: 'sd-left' },
    h('div', { class: 'sd-row is-tight' }, filterBar.element),
    modeChip,
    tree.element,
    h('div', { class: 'sd-btnrow' }, newSiteBtn, manageBtn, toolsBtn));

  /* ---------------- the session form ---------------- */

  const formEl = h('div', { class: 'lg-form' });
  const buttonsEl = h('div', { class: 'sd-btnrow lg-buttons' });
  const right = h('div', { class: 'sd-right' }, formEl, buttonsEl);
  const root = h('div', { class: 'sd-split sd-wide sd-wide-lg' }, left, right);
  appearanceTarget(formEl, 'login-session-form', 'Session form');

  /* ================================================================ */
  /* form state                                                       */
  /* ================================================================ */

  function setField(key, value) {
    state.site[key] = value;
    state.dirty = true;
    renderForm();
  }

  /** Wipe every secret from the working copy. Called after submit and on switch. */
  function forgetSecrets() {
    for (const field of SECRET_FIELDS) {
      if (state.touchedSecrets.has(field)) state.site[field] = '';
    }
    state.touchedSecrets.clear();
  }

  function loadNode(node) {
    forgetSecrets();
    state.dirty = false;
    // A different site's Save-password state is its own; the previous site's
    // explicit choice must not carry over and suppress the offer here.
    state.savePasswordExplicit = false;
    if (!node || node.kind === 'newSite') {
      state.site = newSiteData(defaultSessionTemplate());
      state.sourceId = null;
      state.editing = false;
    } else if (node.kind === 'site') {
      state.site = normalizeSite({ ...node.site });
      state.sourceId = node.site.id;
      state.editing = false;
    } else if (node.kind === 'folder' || node.kind === 'workspace') {
      state.sourceId = null;
      state.editing = false;
    }
    renderForm();
  }

  /** "Set Defaults" stores a template every New Site starts from. */
  function defaultSessionTemplate() {
    const stored = state.prefs?.defaultSession;
    return stored && typeof stored === 'object' ? { ...stored } : {};
  }

  function currentSiteForOutput() {
    // What the URL/code generators and PuTTY see: the working copy with the
    // sentinel removed, so nothing downstream mistakes it for a real password.
    const out = { ...state.site };
    for (const field of SECRET_FIELDS) if (out[field] === SECRET_SENTINEL) out[field] = '';
    return out;
  }

  /* ================================================================ */
  /* rendering                                                        */
  /* ================================================================ */

  function renderForm() {
    const node = tree.selected;
    savePasswordBox = null;
    clear(formEl);
    clear(buttonsEl);

    if (node && (node.kind === 'folder' || node.kind === 'workspace')) {
      renderContainerSummary(node);
      renderButtons();
      return;
    }

    const vis = fieldVisibility(state.site, { editable: true });

    const grid = h('div', { class: 'sd-grid' });
    grid.append(...protocolRow(vis));
    grid.append(...hostRow());
    grid.append(...credentialRows(vis));
    formEl.appendChild(h('fieldset', { class: 'sd-group' },
      h('legend', {}, 'Session'), grid,
      ...protocolExtras(vis)));

    formEl.appendChild(noteGroup());
    formEl.appendChild(saveGroup());
    renderButtons();
  }

  function renderContainerSummary(node) {
    const sites = node.kind === 'folder'
      ? node.children.filter((c) => c.kind === 'site')
      : [];
    const box = h('fieldset', { class: 'sd-group' },
      h('legend', {}, node.kind === 'folder' ? t('siteFolder') : t('workspaces')),
      h('p', { class: 'prose' }, node.label));
    if (node.kind === 'folder') {
      box.appendChild(h('p', { class: 'sd-hint prose' },
        sites.length
          ? `${sites.length} ${sites.length === 1 ? 'site' : 'sites'} in this folder. Logging in opens all of them.`
          : 'This folder has no sites yet.'));
      for (const child of sites) {
        box.appendChild(h('div', { class: 'sd-hint' }, `• ${child.label} — ${siteSummary(child.site)}`));
      }
    } else {
      const sessions = Array.isArray(node.workspace?.sessions) ? node.workspace.sessions : [];
      box.appendChild(h('p', { class: 'sd-hint prose' },
        sessions.length
          ? `${sessions.length} ${sessions.length === 1 ? 'session' : 'sessions'} are restored when this workspace is opened.`
          : 'This workspace has no sessions recorded.'));
      for (const s of sessions) {
        box.appendChild(h('div', { class: 'sd-hint' }, `• ${s.name || s.hostName || 'session'}`));
      }
    }
    formEl.appendChild(box);
  }

  function protocolRow(vis) {
    const protocolId = uid('lg-proto');
    const protocolSelect = h('select', {
      id: protocolId, class: 'sd-input',
      onchange: () => {
        const previous = { ...state.site };
        state.site.protocol = protocolSelect.value;
        const options = encryptionOptions(state.site.protocol);
        if (!options.some((e) => e.id === state.site.ftps)) {
          state.site.ftps = state.site.protocol === 's3' ? 'implicit' : 'none';
        }
        state.site = normalizeSite(state.site, previous);
        state.dirty = true;
        renderForm();
        announce(`${t('fileProtocol')}: ${protocolInfo(state.site.protocol).label}`);
      },
    }, ...PROTOCOLS.map((p) => h('option', { value: p.id }, p.label)));
    protocolSelect.value = state.site.protocol;

    const rows = [
      h('label', { class: 'sd-label', for: protocolId }, t('fileProtocol')),
      protocolSelect,
    ];

    // FtpsCombo and WebDavsCombo are two different controls in the original,
    // shown for different protocols and holding different item lists.
    const options = encryptionOptions(state.site.protocol);
    if (options.length && (vis.ftpsCombo || vis.webDavsCombo)) {
      const encId = uid('lg-enc');
      const encSelect = h('select', {
        id: encId, class: 'sd-input',
        'data-control': vis.ftpsCombo ? 'FtpsCombo' : 'WebDavsCombo',
        onchange: () => {
          const previous = { ...state.site };
          state.site.ftps = encSelect.value;
          state.site = normalizeSite(state.site, previous);
          state.dirty = true;
          renderForm();
        },
      }, ...options.map((e) => h('option', { value: e.id }, e.label)));
      encSelect.value = state.site.ftps;
      rows.push(h('label', { class: 'sd-label', for: encId }, t('encryption')), encSelect);
    }
    return rows;
  }

  function hostRow() {
    const hostId = uid('lg-host');
    const portId = uid('lg-port');
    const hostInput = h('input', {
      type: 'text', id: hostId, class: 'sd-input', spellcheck: 'false',
      autocomplete: 'off', placeholder: 'example.com', required: true, 'aria-required': 'true',
      autofocus: !state.sourceId,
      oninput: () => { state.site.hostName = hostInput.value; state.dirty = true; syncButtons(); },
    });
    hostInput.value = state.site.hostName;

    const portInput = h('input', {
      type: 'number', id: portId, class: 'sd-input sd-num', min: '1', max: '65535',
      oninput: () => { state.site.portNumber = Number(portInput.value) || 0; state.dirty = true; },
      onchange: () => {
        const n = Math.min(65535, Math.max(1, Number(portInput.value) || defaultPortFor(state.site.protocol, state.site.ftps)));
        portInput.value = String(n);
        setField('portNumber', n);
      },
    });
    portInput.value = String(state.site.portNumber);

    const resetPort = h('button', {
      type: 'button', class: 'btn-text',
      title: `Reset to the protocol default (${defaultPortFor(state.site.protocol, state.site.ftps)})`,
      onclick: () => setField('portNumber', defaultPortFor(state.site.protocol, state.site.ftps)),
    }, icon('restart_alt', 15));

    return [
      h('label', { class: 'sd-label', for: hostId }, t('hostName')),
      hostInput,
      h('label', { class: 'sd-label', for: portId }, t('portNumber')),
      h('div', { class: 'sd-row is-tight' }, portInput, resetPort),
    ];
  }

  function credentialRows(vis) {
    const userId = uid('lg-user');
    const passId = uid('lg-pass');

    const userInput = h('input', {
      type: 'text', id: userId, class: 'sd-input', spellcheck: 'false', autocomplete: 'username',
      oninput: () => { state.site.userName = userInput.value; state.dirty = true; syncButtons(); },
    });
    userInput.value = state.site.userName;
    userInput.disabled = !vis.userNameEnabled;

    const stored = state.site.password === SECRET_SENTINEL;
    const passInput = h('input', {
      type: 'password', id: passId, class: 'sd-input', autocomplete: 'new-password',
      placeholder: stored && !state.touchedSecrets.has('password') ? '(unchanged — type to replace)' : '',
      oninput: () => {
        state.touchedSecrets.add('password');
        state.site.password = passInput.value;
        // Typing a password offers to keep it — but only while the user has not
        // said otherwise. Re-enabling it silently after they unticked the box
        // would store a password the interface is still showing as not stored,
        // which is the one disagreement a credential control must never have.
        if (!state.savePasswordExplicit && passInput.value && !state.site.savePassword) {
          state.site.savePassword = true;
          syncSavePasswordBox();
        }
        state.dirty = true;
      },
    });
    passInput.value = state.touchedSecrets.has('password') ? String(state.site.password || '') : '';
    passInput.disabled = !vis.passwordEnabled;

    const revealBtn = h('button', {
      type: 'button', class: 'icon-btn', 'aria-pressed': 'false',
      'aria-label': 'Show the password', title: 'Show the password',
      onclick: () => {
        const on = revealBtn.getAttribute('aria-pressed') === 'true';
        revealBtn.setAttribute('aria-pressed', String(!on));
        passInput.type = on ? 'password' : 'text';
        // Announced rather than silent: a revealed password on a shared screen
        // should never be a surprise.
        announce(on ? 'Password hidden.' : 'Password shown.');
      },
    }, icon('visibility', 16));
    revealBtn.disabled = !vis.passwordEnabled;

    const rows = [
      h('label', { class: `sd-label${vis.userNameEnabled ? '' : ' is-disabled'}`, for: userId },
        vis.userNameLabel || t('userName')),
      userInput,
      h('label', { class: `sd-label${vis.passwordEnabled ? '' : ' is-disabled'}`, for: passId },
        vis.passwordLabel || t('password')),
      h('div', { class: 'lg-secret' }, passInput, revealBtn),
    ];

    if (stored && !state.touchedSecrets.has('password')) {
      rows.push(h('span', { class: 'sd-label' }, ''),
        h('span', { class: 'sd-hint' },
          'A password is stored for this site. It is never sent back to this window; leave the box empty to keep it.'));
    }
    if (!vis.userNameEnabled) {
      rows.push(h('span', { class: 'sd-label' }, ''),
        h('span', { class: 'sd-hint' }, vis.s3
          ? 'Credentials are being taken from the AWS environment, so these fields are not used.'
          : 'Authentication is bypassed for this site, so these fields are not used.'));
    }
    return rows;
  }

  /** BasicFtpPanel / BasicS3Panel / BasicSshPanel — one at a time, as in the original. */
  function protocolExtras(vis) {
    const out = [];

    if (vis.basicFtpPanel) {
      const id = uid('lg-anon');
      const box = h('input', {
        type: 'checkbox', id,
        onchange: () => {
          if (box.checked) {
            state.touchedSecrets.add('password');
            state.site.userName = ANONYMOUS_USER;
            state.site.password = ANONYMOUS_PASSWORD;
            state.site.savePassword = true;
            state.site.anonymous = true;
          } else {
            state.touchedSecrets.add('password');
            state.site.userName = '';
            state.site.password = '';
            state.site.anonymous = false;
          }
          state.dirty = true;
          renderForm();
        },
      });
      box.checked = isAnonymous(state.site);
      out.push(h('label', { class: 'sd-check', for: id }, box,
        h('span', { class: 'sd-check-text' }, t('anonymousLogin'),
          h('span', { class: 'sd-hint', style: { display: 'block' } },
            `Signs in as ${ANONYMOUS_USER} with ${ANONYMOUS_PASSWORD} as the password, which is what anonymous FTP expects.`))));
    }

    if (vis.basicS3Panel) {
      const envId = uid('lg-s3env');
      const profileId = uid('lg-s3profile');
      const envBox = h('input', {
        type: 'checkbox', id: envId,
        onchange: () => setField('s3CredentialsEnv', envBox.checked),
      });
      envBox.checked = !!state.site.s3CredentialsEnv;
      const profileInput = h('input', {
        type: 'text', id: profileId, class: 'sd-input', spellcheck: 'false',
        list: 'lg-s3-profiles', placeholder: 'default',
        oninput: () => { state.site.s3Profile = profileInput.value; state.dirty = true; },
      });
      profileInput.value = state.site.s3Profile || '';
      profileInput.disabled = !vis.s3ProfileEnabled;
      out.push(h('div', { class: 'sd-row' },
        h('label', { class: 'sd-check', for: envId }, envBox,
          h('span', { class: 'sd-check-text' }, t('credAws'))),
        h('label', { class: `sd-label${vis.s3ProfileEnabled ? '' : ' is-disabled'}`, for: profileId }, s('profile')),
        profileInput));
    }

    if (vis.basicSshPanel) {
      const keyId = uid('lg-key');
      const keyInput = h('input', {
        type: 'text', id: keyId, class: 'sd-input', spellcheck: 'false',
        placeholder: s('noKeyFile'),
        oninput: () => { state.site.publicKeyFile = keyInput.value; state.dirty = true; },
      });
      keyInput.value = state.site.publicKeyFile || '';
      const browse = h('button', {
        type: 'button', class: 'btn-tonal',
        onclick: async () => {
          const picked = await pickLocalPath({ title: 'Private key file' });
          if (picked) { keyInput.value = picked; setField('publicKeyFile', picked); }
        },
      }, icon('key', 15), h('span', {}, t('browse')));
      out.push(h('div', { class: 'sd-grid' },
        h('label', { class: 'sd-label', for: keyId }, s('privateKeyFile')),
        h('div', { class: 'sd-row is-tight' }, keyInput, browse)));
    }

    return out;
  }

  function noteGroup() {
    const id = uid('lg-note');
    const area = h('textarea', {
      id, class: 'sd-input', rows: '3', spellcheck: 'true',
      oninput: () => { state.site.note = area.value; state.dirty = true; },
    });
    area.value = state.site.note || '';
    return h('fieldset', { class: 'sd-group' },
      h('legend', {}, t('siteNote')),
      h('label', { class: 'sr-only', for: id }, t('siteNote')),
      area,
      h('p', { class: 'sd-hint' }, 'Searched by the "all major site fields" mode, alongside the host and user name.'));
  }

  function saveGroup() {
    const nameId = uid('lg-name');
    const folderId = uid('lg-folder');
    const nameInput = h('input', {
      type: 'text', id: nameId, class: 'sd-input',
      placeholder: t('siteNamePh'),
      oninput: () => { state.site.name = nameInput.value; state.dirty = true; },
    });
    nameInput.value = state.site.name || '';

    const folders = ['', ...(tree.data.folders || [])];
    const folderSelect = h('select', {
      id: folderId, class: 'sd-input',
      onchange: () => setField('folder', folderSelect.value),
    }, ...folders.map((f) => h('option', { value: f }, f || '(top level)')));
    folderSelect.value = folders.includes(state.site.folder) ? state.site.folder : '';

    const saveId = uid('lg-savepw');
    const saveBox = h('input', {
      type: 'checkbox', id: saveId,
      onchange: () => {
        // From here on the choice is the user's, not the form's.
        state.savePasswordExplicit = true;
        state.site.savePassword = saveBox.checked;
        // Turning it off is a real deletion, so say so rather than leaving the
        // user to discover it at the next login.
        if (!saveBox.checked && (state.site.password || state.sourceId)) {
          notify.info(t('savePassword'), 'The stored password will be deleted when this site is saved.');
        }
        state.dirty = true;
        renderForm();
      },
    });
    saveBox.checked = !!state.site.savePassword;
    // The password field lives in a different fieldset and does not re-render
    // on every keystroke, so it needs a way to keep this box honest.
    savePasswordBox = saveBox;

    const swatch = colorSwatchButton({
      value: state.site.color || '#0B57D0',
      label: t('siteColor'),
      alpha: false,
      onChange: (hex) => { state.site.color = hex; state.dirty = true; },
    });
    const clearColor = h('button', {
      type: 'button', class: 'btn-text',
      onclick: () => setField('color', ''),
    }, t('none'));

    return h('fieldset', { class: 'sd-group' },
      h('legend', {}, t('save')),
      h('div', { class: 'sd-grid' },
        h('label', { class: 'sd-label', for: nameId }, t('siteName')),
        nameInput,
        h('label', { class: 'sd-label', for: folderId }, t('siteFolder')),
        folderSelect,
        h('span', { class: 'sd-label' }, t('siteColor')),
        h('div', { class: 'sd-row is-tight' }, swatch.element, clearColor,
          state.site.color ? h('span', { class: 'sd-hint mono' }, state.site.color) : null)),
      h('label', { class: 'sd-check', for: saveId }, saveBox,
        h('span', { class: 'sd-check-text' }, t('savePassword'),
          h('span', { class: 'sd-hint', style: { display: 'block' } },
            'Stored encrypted by the application, and protected by the master password when one is set.'))));
  }

  /* ---------------- buttons ---------------- */

  let loginBtn = null;

  function renderButtons() {
    clear(buttonsEl);
    const node = tree.selected;
    const isContainer = node && (node.kind === 'folder' || node.kind === 'workspace');

    loginBtn = h('button', { type: 'button', class: 'btn-filled', onclick: doLogin },
      icon('shield_lock', 16), h('span', {}, t('loginBtn')));
    appearanceTarget(loginBtn, 'login-login-button', 'Login button');

    const saveBtn = h('button', { type: 'button', class: 'btn-tonal', onclick: () => doSave(false) },
      icon('bookmark', 16), h('span', {}, t('save')));
    const saveAsBtn = h('button', { type: 'button', class: 'btn-text', onclick: () => doSave(true) },
      h('span', {}, t('saveAs')));
    const advancedBtn = h('button', { type: 'button', class: 'btn-text', onclick: () => openAdvanced() },
      icon('tune', 15), h('span', {}, t('advancedBtn')));
    const closeBtn = h('button', { type: 'button', class: 'btn-text', onclick: () => opts.onClose?.() },
      h('span', {}, t('close')));

    if (isContainer) {
      buttonsEl.append(loginBtn, h('span', { class: 'spacer' }), closeBtn);
    } else {
      buttonsEl.append(loginBtn, saveBtn, saveAsBtn, advancedBtn,
        h('span', { class: 'spacer' }), closeBtn);
    }
    syncButtons();
  }

  function syncButtons() {
    if (!loginBtn) return;
    const node = tree.selected;
    const container = node && (node.kind === 'folder' || node.kind === 'workspace');
    const ready = container ? true : !!state.site.hostName;
    loginBtn.disabled = !ready;
    loginBtn.title = ready ? '' : t('hostRequired');
  }

  /* ================================================================ */
  /* actions                                                          */
  /* ================================================================ */

  async function doLogin() {
    const node = tree.selected;
    if (node && node.kind === 'folder') return openFolder(node);
    if (node && node.kind === 'workspace') return openWorkspace(node);

    if (!state.site.hostName) {
      notify.warning(t('loginBtn'), t('hostRequired'));
      return null;
    }
    return openSession(buildRequest(), siteLabel(state.site));
  }

  /**
   * The request that crosses to main. A site the user has not edited is opened
   * by id so its stored password never has to travel; an edited or brand-new
   * one travels as data, and the working copy's secrets are wiped immediately
   * afterwards.
   */
  function buildRequest() {
    if (state.sourceId && !state.dirty) return { siteId: state.sourceId, connect: true };
    const keep = SECRET_FIELDS.filter((f) => state.touchedSecrets.has(f));
    return { data: stripSecrets({ ...state.site }, { keep }), connect: true };
  }

  async function openSession(request, label) {
    try {
      const call = api.raw?.session?.open;
      if (!call) {
        notify.error(t('loginBtn'), 'The application shell is not present in this window, so no session can be opened.');
        return null;
      }
      notify.info(t('connecting', label), t('searchingHost'));
      const res = await call(request);
      if (!res?.ok) throw new Error(res?.error?.message || 'The session could not be opened.');
      forgetSecrets();
      notify.success(t('connEstablished', label), siteSummary(state.site));
      bus.emit('login:opened', res.value);
      opts.onLogin?.(res.value);
      return res.value;
    } catch (err) {
      // Connection failure is information, not a decision: a persistent error
      // toast, and the dialog stays exactly as the user left it.
      notify.error(t('loginBtn'), err.message || String(err));
      return null;
    } finally {
      forgetSecrets();
    }
  }

  async function openFolder(node) {
    const sites = node.children.filter((c) => c.kind === 'site');
    if (!sites.length) { notify.warning(t('loginBtn'), 'This folder has no sites to open.'); return; }
    let opened = 0;
    for (const child of sites) {
      const info = await openSession({ siteId: child.site.id, connect: true }, child.label);
      if (info) opened += 1;
    }
    notify.success(t('loginBtn'), `${opened} of ${sites.length} sites opened.`);
  }

  async function openWorkspace(node) {
    const sessions = Array.isArray(node.workspace?.sessions) ? node.workspace.sessions : [];
    if (!sessions.length) { notify.warning(t('workspaces'), 'This workspace has no sessions recorded.'); return; }
    let opened = 0;
    for (const entry of sessions) {
      const request = entry.siteId ? { siteId: entry.siteId, connect: true } : { data: entry, connect: true };
      const info = await openSession(request, entry.name || entry.hostName || 'session');
      if (info) opened += 1;
    }
    notify.success(t('workspaces'), `${opened} of ${sessions.length} sessions restored.`);
  }

  async function doSave(saveAs) {
    if (!state.site.hostName) { notify.warning(t('save'), t('hostRequired')); return; }
    const name = state.site.name || `${state.site.userName ? `${state.site.userName}@` : ''}${state.site.hostName}`;

    if (saveAs || !state.sourceId) {
      openPrompt({
        title: saveAs ? t('saveAs') : t('save'),
        label: t('siteName'),
        value: name,
        onSubmit: async (chosen) => {
          const keep = SECRET_FIELDS.filter((f) => state.touchedSecrets.has(f));
          const record = stripSecrets({ ...state.site, name: chosen || name }, { keep });
          delete record.id;
          try {
            const saved = await siteStore.addSite(record);
            forgetSecrets();
            state.sourceId = saved?.id || null;
            state.dirty = false;
            notifySitesChanged();
            await tree.refresh();
            if (saved?.id) tree.select(`site:${saved.id}`);
            notify.success(t('siteSaved', chosen || name), '');
          } catch (err) { notify.error(t('save'), err.message || String(err)); }
        },
      });
      return;
    }

    try {
      const keep = SECRET_FIELDS.filter((f) => state.touchedSecrets.has(f));
      const patch = stripSecrets({ ...state.site, name }, { keep });
      await siteStore.updateSite(state.sourceId, patch);
      forgetSecrets();
      state.dirty = false;
      notifySitesChanged();
      await tree.refresh();
      notify.success(t('siteSaved', name), '');
    } catch (err) { notify.error(t('save'), err.message || String(err)); }
  }

  function openAdvanced(pageId) {
    const working = { ...state.site };
    let panel = null;
    const modal = openModal({
      title: `${t('advancedBtn')}${state.site.name ? ` — ${state.site.name}` : ''}`,
      width: 980,
      content: (close) => {
        panel = createSiteAdvancedPanel(working, {
          prefs: state.prefs,
          pageId,
          onAction: advancedAction,
        });
        void close;
        return panel.element;
      },
      actions: [
        { label: t('cancel'), kind: 'text', onSelect: () => panel?.destroy() },
        {
          label: t('ok'), kind: 'filled', autofocus: true,
          onSelect: () => {
            for (const field of panel.touchedSecrets) state.touchedSecrets.add(field);
            state.site = { ...state.site, ...panel.site };
            state.dirty = true;
            panel.destroy();
            renderForm();
            announce(t('settingsSaved'));
          },
        },
      ],
    });
    return modal;
  }

  /**
   * The Advanced dialog's own buttons come back here for the real work.
   * `helpers` is how a handler writes back: setSecret() also marks the field
   * as touched, without which the save path would treat the value as unchanged
   * and drop it.
   */
  async function advancedAction(id, site, helpers) {
    switch (id) {
      case 'generateEncryptionKey': {
        const key = randomBase64Key(32);
        helpers.setSecret('encryptKey', key);
        if (!site.encryptFiles) helpers.setValue('encryptFiles', true);
        // Shown once, in a modal the user must acknowledge: this key is the
        // only thing that can decrypt the files, and nothing else holds a copy.
        openModal({
          title: 'Encryption key generated',
          width: 560,
          content: h('div', { class: 'stack' },
            h('p', { class: 'prose' },
              'This key is stored with the site and used to encrypt files before upload. Nothing else holds a copy — if the site is deleted without a backup of this key, the files it encrypted cannot be recovered.'),
            h('textarea', { class: 'gu-result', readonly: true, rows: 2, 'aria-label': 'Encryption key' , ref: (el) => { el.value = key; } })),
          actions: [
            { label: t('copyClip'), kind: 'text', onSelect: () => { copyText(key); return true; } },
            { label: t('ok'), kind: 'filled', autofocus: true },
          ],
        });
        return key;
      }
      case 'runPuttygen': return runExternalTool('puttygenPath', 'PuTTYgen');
      case 'installKey': return installPublicKey(site);
      case 'displayPublicKey': return displayPublicKey(site);
      case 'editInPutty': return openInPutty(site, { settingsOnly: true });
      case 'autodetectProxy': {
        notify.info('Proxy', 'System proxy detection is not available from this runtime, so nothing was changed. Choose the proxy type explicitly — connecting direct while you believed a proxy was in use would be a privacy failure, not a convenience.');
        return null;
      }
      case 'browseProxyCommand': {
        const picked = await pickLocalPath({ title: 'Local proxy command' });
        if (picked) helpers.setValue('proxyLocalCommand', picked);
        return picked;
      }
      default:
        notify.warning(t('advancedBtn'), `No handler is registered for "${id}".`);
        return null;
    }
  }

  /* ---------------- menus ---------------- */

  function toolsMenuItems() {
    return [
      { label: t('importSites'), icon: 'file_upload', onSelect: () => openImportSessions({ onImported: () => tree.refresh() }) },
      SEPARATOR,
      { label: t('importRestoreCfg'), icon: 'upload', onSelect: importConfiguration },
      { label: t('exportBackupCfg'), icon: 'download', onSelect: exportConfiguration },
      { label: t('cleanUp'), icon: 'delete', onSelect: openCleanUp },
      SEPARATOR,
      { label: t('runPageant'), icon: 'key', onSelect: () => runExternalTool('pageantPath', 'Pageant') },
      { label: t('runPuttygen'), icon: 'key', onSelect: () => runExternalTool('puttygenPath', 'PuTTYgen') },
      SEPARATOR,
      { label: t('checkUpdates'), icon: 'refresh', onSelect: checkForUpdates },
      SEPARATOR,
      { label: t('preferences'), icon: 'settings', shortcut: 'Ctrl+,', onSelect: () => runCommand('app.preferences') },
      { label: t('aboutMenu'), icon: 'info', shortcut: 'F1', onSelect: () => runCommand('app.about') },
    ];
  }

  /**
   * The Manage menu is the original's four context menus in one: the entries
   * change with the selected node's kind, exactly as SessionTree's do.
   */
  function manageMenuItems(node) {
    const selected = node || tree.selected;
    const kind = selected ? selected.kind : 'newSite';
    const searchSub = {
      label: t('searchSites'), icon: 'search',
      submenu: [
        { label: s('findSite'), icon: 'search', shortcut: 'Ctrl+F', onSelect: () => filterBar.focus() },
        SEPARATOR,
        ...SITE_SEARCH_MODES.map((m) => ({
          label: m.label, checked: tree.searchMode === m.id, radio: true,
          onSelect: () => { tree.setSearchMode(m.id); paintModeChip(); },
        })),
      ],
    };
    const sessionSub = {
      label: s('sessionMenu'), icon: 'dns',
      submenu: [
        { label: t('advancedBtn'), icon: 'tune', onSelect: () => openAdvanced() },
        { label: t('editRaw'), icon: 'code', onSelect: openRawSettings },
        { label: s('transferRule'), icon: 'swap_vert', onSelect: openTransferRule },
      ],
    };
    const globalSub = {
      label: s('globalPrefsMenu'), icon: 'settings',
      submenu: [
        { label: t('loggingBtn'), icon: 'receipt_long', onSelect: () => openPreferencesPage('logging') },
        { label: t('preferences'), icon: 'settings', onSelect: () => runCommand('app.preferences') },
      ],
    };
    const shellSub = (label) => ({
      label, icon: 'computer',
      submenu: [
        { label: s('desktopIcon'), icon: 'open_in_new', onSelect: () => createShortcut('desktop') },
        { label: s('sendToShortcut'), icon: 'open_in_new', onSelect: () => createShortcut('sendto') },
      ],
    });

    if (kind === 'site') {
      return [
        { label: t('loginBtn'), icon: 'shield_lock', onSelect: doLogin },
        { label: t('openPutty'), icon: 'terminal', onSelect: () => openInPutty(currentSiteForOutput()) },
        SEPARATOR,
        { label: t('edit'), icon: 'edit', onSelect: () => { state.editing = true; renderForm(); } },
        { label: t('delete_'), icon: 'delete', danger: true, onSelect: deleteSelected },
        { label: t('rename'), icon: 'label', shortcut: 'F2', onSelect: () => tree.beginRename(selected.id) },
        { label: t('cloneSite'), icon: 'content_copy', onSelect: cloneToNewSite },
        { label: t('genUrlSite'), icon: 'code', onSelect: () => openGenerateUrl(currentSiteForOutput()) },
        SEPARATOR,
        { label: t('setDefaults'), icon: 'star', onSelect: setDefaults },
        SEPARATOR,
        { label: t('newFolder'), icon: 'folder', onSelect: () => tree.promptNewFolder(selected.path) },
        shellSub(s('siteShellIcon')),
        searchSub,
        SEPARATOR,
        sessionSub,
        globalSub,
      ];
    }
    if (kind === 'folder') {
      return [
        { label: t('loginBtn'), icon: 'shield_lock', onSelect: doLogin },
        { label: t('openPutty'), icon: 'terminal', disabled: true, onSelect: () => {} },
        SEPARATOR,
        { label: t('delete_'), icon: 'delete', danger: true, onSelect: deleteSelected },
        { label: t('rename'), icon: 'label', shortcut: 'F2', onSelect: () => tree.beginRename(selected.id) },
        SEPARATOR,
        { label: t('newFolder'), icon: 'folder', onSelect: () => tree.promptNewFolder(selected.path) },
        shellSub(s('folderShellIcon')),
        searchSub,
        SEPARATOR,
        globalSub,
      ];
    }
    if (kind === 'workspace') {
      return [
        { label: t('loginBtn'), icon: 'shield_lock', onSelect: doLogin },
        SEPARATOR,
        { label: t('delete_'), icon: 'delete', danger: true, onSelect: deleteSelected },
        { label: t('rename'), icon: 'label', shortcut: 'F2', onSelect: () => tree.beginRename(selected.id) },
        shellSub(s('workspaceShellIcon')),
        searchSub,
        SEPARATOR,
        globalSub,
      ];
    }
    // New Site
    return [
      { label: t('loginBtn'), icon: 'shield_lock', onSelect: doLogin },
      { label: t('openPutty'), icon: 'terminal', onSelect: () => openInPutty(currentSiteForOutput()) },
      SEPARATOR,
      { label: t('saveAs'), icon: 'bookmark', onSelect: () => doSave(true) },
      { label: t('reset'), icon: 'restart_alt', onSelect: resetNewSession },
      { label: t('pasteUrl'), icon: 'content_copy', shortcut: 'Ctrl+V', onSelect: pasteSessionUrl },
      { label: t('genUrlSite'), icon: 'code', onSelect: () => openGenerateUrl(currentSiteForOutput()) },
      SEPARATOR,
      { label: t('setDefaults'), icon: 'star', onSelect: setDefaults },
      SEPARATOR,
      { label: t('newFolder'), icon: 'folder', onSelect: () => tree.promptNewFolder('') },
      { label: t('saveSessionSite'), icon: 'group_work', onSelect: saveWorkspace },
      searchSub,
      SEPARATOR,
      sessionSub,
      globalSub,
    ];
  }

  /* ---------------- individual action implementations ---------------- */

  /**
   * Delete whatever is selected. Each kind is a separate, irreversible
   * decision, so each gets its own confirmation naming exactly what goes.
   */
  function deleteSelected() {
    const node = tree.selected;
    if (!node || node.kind === 'newSite') return;
    if (node.kind === 'site') {
      openConfirm({
        title: t('deleteTitle'),
        body: `Delete the site "${node.label}"? Its stored password is deleted with it.`,
        danger: true,
        confirmLabel: t('delete_'),
        onConfirm: async () => {
          await siteStore.removeSite(node.site.id);
          notify.success(t('siteDeleted', node.label), '');
          notifySitesChanged();
          await tree.refresh();
          tree.select('new-site');
          loadNode(tree.selected);
        },
      });
    } else if (node.kind === 'folder') {
      openConfirm({
        title: t('deleteTitle'),
        body: `Delete the folder "${node.label}"? Choose Move out to keep the sites and remove only the folder.`,
        danger: true,
        confirmLabel: 'Delete folder and sites',
        extraLabel: 'Move out, delete folder',
        onExtra: async () => {
          await siteStore.removeFolder(node.path, false);
          notifySitesChanged();
          await tree.refresh();
        },
        onConfirm: async () => {
          await siteStore.removeFolder(node.path, true);
          notifySitesChanged();
          await tree.refresh();
        },
      });
    } else {
      openConfirm({
        title: t('deleteTitle'),
        body: `Delete the workspace "${node.label}"? The sites it references are not deleted.`,
        danger: true,
        confirmLabel: t('delete_'),
        onConfirm: async () => {
          await siteStore.removeWorkspace(node.workspace?.name || node.label);
          notifySitesChanged();
          await tree.refresh();
        },
      });
    }
  }

  function cloneToNewSite() {
    const source = tree.selected;
    if (!source || source.kind !== 'site') return;
    // A clone starts from the stored record but drops its identity and its
    // password: the sentinel would otherwise be written back as a literal.
    state.site = normalizeSite({ ...source.site, id: '', name: `${source.label} (copy)`, password: '' });
    state.sourceId = null;
    state.touchedSecrets.clear();
    state.dirty = true;
    tree.select('new-site', { notifyHost: false });
    renderForm();
    notify.info(t('cloneSite'), 'Edit the copy and choose Save to store it. The original site is untouched, and its password was not copied.');
  }

  function resetNewSession() {
    state.site = newSiteData();
    state.sourceId = null;
    state.touchedSecrets.clear();
    state.dirty = false;
    renderForm();
    announce(t('reset'));
  }

  async function setDefaults() {
    const template = stripSecrets({ ...state.site });
    delete template.id;
    delete template.name;
    delete template.folder;
    delete template.hostName;
    delete template.userName;
    delete template.note;
    try {
      const call = api.raw?.config?.setPref;
      if (call) {
        const res = await call('defaultSession', template, 'Changed the default settings for new sites');
        if (!res?.ok) throw new Error(res?.error?.message || 'The default could not be stored.');
      }
      state.prefs = { ...state.prefs, defaultSession: template };
      notify.success(t('setDefaults'), 'New sites now start from these settings. The host name, user name, site name and note are deliberately not part of the template.');
    } catch (err) { notify.error(t('setDefaults'), err.message || String(err)); }
  }

  async function pasteSessionUrl() {
    let text = '';
    try {
      const res = await api.raw?.app?.clipboardRead?.();
      text = res?.ok ? String(res.value || '') : '';
    } catch { /* fall through */ }
    if (!text) { try { text = await navigator.clipboard.readText(); } catch { text = ''; } }
    if (!text) { notify.warning(t('pasteUrl'), 'The clipboard is empty, or this window was refused access to it.'); return; }

    const parsed = parseSessionUrl(text.trim());
    if (!parsed.ok) { notify.error(t('pasteUrl'), parsed.error); return; }
    const patch = siteFromParsedUrl(parsed);
    state.site = normalizeSite({ ...newSiteData(), ...patch });
    state.sourceId = null;
    if (parsed.hasPassword) state.touchedSecrets.add('password');
    state.dirty = true;
    tree.select('new-site', { notifyHost: false });
    renderForm();
    // The URL may have carried a password. Say that it did, never what it was.
    notify.success(t('pasteUrl'), parsed.hasPassword
      ? `${parsed.hostName} — the URL included a password, which was put in the password box.`
      : parsed.hostName);
  }

  /**
   * Edit Raw Settings: the site as `Name=Value` lines, restricted to the keys
   * that differ from the defaults so the box is readable. Unknown keys are
   * rejected by name rather than silently dropped.
   */
  function openRawSettings() {
    const defaults = SESSION_DEFAULTS;
    const lines = [];
    for (const [key, value] of Object.entries(state.site)) {
      if (SECRET_FIELDS.includes(key) || key === 'id') continue;
      const def = defaults[key];
      const same = JSON.stringify(value) === JSON.stringify(def);
      if (same) continue;
      lines.push(`${key}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}`);
    }
    const area = h('textarea', {
      class: 'gu-result', rows: '14', spellcheck: 'false', 'aria-label': t('editRaw'),
    });
    area.value = lines.join('\n');
    const errorEl = h('div', { class: 'sd-note is-warn', hidden: true });

    openModal({
      title: t('editRaw'),
      width: 720,
      content: h('div', { class: 'stack' },
        h('p', { class: 'prose' },
          'One Name=Value per line. Only the settings that differ from the defaults are listed; deleting a line restores that default. Passwords are never shown here and cannot be set from here.'),
        errorEl, area),
      actions: [
        { label: t('cancel'), kind: 'text' },
        {
          label: t('ok'), kind: 'filled', autofocus: true,
          onSelect: (close) => {
            const result = applyRawSettings(area.value);
            if (result.errors.length) {
              clear(errorEl);
              errorEl.hidden = false;
              errorEl.append(icon('warning', 15), h('span', {}, result.errors.join(' ')));
              return true;                                // keep the dialog open
            }
            state.dirty = true;
            renderForm();
            notify.success(t('editRaw'), `${result.applied} setting${result.applied === 1 ? '' : 's'} applied.`);
            close('applied');
            return true;
          },
        },
      ],
    });
  }

  function applyRawSettings(textValue) {
    const errors = [];
    const next = { ...newSiteData(), id: state.site.id, name: state.site.name, folder: state.site.folder };
    for (const field of SECRET_FIELDS) next[field] = state.site[field];
    let applied = 0;
    for (const raw of String(textValue).split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith(';')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) { errors.push(`"${oneLine(line, 40)}" is not Name=Value.`); continue; }
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1);
      if (!(key in SESSION_DEFAULTS)) { errors.push(`"${key}" is not a session setting.`); continue; }
      if (SECRET_FIELDS.includes(key)) { errors.push(`"${key}" holds a secret and cannot be set here.`); continue; }
      const def = SESSION_DEFAULTS[key];
      try {
        if (typeof def === 'boolean') next[key] = value.trim() === 'true' || value.trim() === '1';
        else if (typeof def === 'number') {
          const n = Number(value);
          if (!Number.isFinite(n)) throw new Error('not a number');
          next[key] = n;
        } else if (Array.isArray(def) || (def && typeof def === 'object')) next[key] = JSON.parse(value);
        else next[key] = value;
        applied += 1;
      } catch (err) {
        errors.push(`"${key}": ${err.message}.`);
      }
    }
    if (!errors.length) state.site = next;
    return { applied, errors };
  }

  /**
   * Transfer Settings Rule: which transfer preset this site auto-selects. The
   * presets come from the preferences document, so the list is the real one.
   */
  function openTransferRule() {
    const presets = Array.isArray(state.prefs?.copyParamList) ? state.prefs.copyParamList : [];
    const id = uid('lg-rule');
    const select = h('select', { id, class: 'sd-input' },
      h('option', { value: '' }, '(use the default transfer settings)'),
      ...presets.map((p) => h('option', { value: p.id || p.name }, p.name || p.id)));
    select.value = state.site.copyParamRule || '';
    const maskId = uid('lg-rulemask');
    const maskInput = h('input', { type: 'text', id: maskId, class: 'sd-input', placeholder: '*.log; *.txt' });
    maskInput.value = state.site.copyParamRuleMask || '';

    openModal({
      title: 'Transfer Settings Rule',
      width: 560,
      content: h('div', { class: 'stack' },
        h('p', { class: 'prose' },
          'Choose the transfer preset this site uses by default, and optionally a file mask that narrows the rule to matching files.'),
        presets.length ? null : h('div', { class: 'sd-note' }, icon('info', 15),
          h('span', {}, 'No named transfer presets are defined yet. Add one in Preferences → Transfer → Presets, then come back.')),
        h('div', { class: 'sd-grid' },
          h('label', { class: 'sd-label', for: id }, 'Preset'),
          select,
          h('label', { class: 'sd-label', for: maskId }, 'File mask'),
          maskInput)),
      actions: [
        { label: t('cancel'), kind: 'text' },
        {
          label: t('ok'), kind: 'filled', autofocus: true,
          onSelect: () => {
            state.site.copyParamRule = select.value;
            state.site.copyParamRuleMask = maskInput.value;
            state.dirty = true;
            notify.success('Transfer Settings Rule',
              select.value ? `This site will use "${select.options[select.selectedIndex].textContent}".`
                : 'This site will use the default transfer settings.');
          },
        },
      ],
    });
  }

  async function saveWorkspace() {
    openPrompt({
      title: t('saveSessionSite'),
      label: t('name'),
      value: '',
      onSubmit: async (name) => {
        if (!name) return;
        try {
          const call = api.raw?.config?.saveWorkspace;
          if (call) {
            const res = await call(name, undefined);
            if (!res?.ok) throw new Error(res?.error?.message || 'The workspace could not be saved.');
          } else {
            await siteStore.saveWorkspace(name, []);
          }
          notifySitesChanged();
          await tree.refresh();
          notify.success(t('workspaceSaved'), name);
        } catch (err) { notify.error(t('saveSessionSite'), err.message || String(err)); }
      },
    });
  }

  /* ---------------- configuration import / export ---------------- */

  async function exportConfiguration() {
    try {
      const path = await pickLocalPath({ save: true, title: t('exportBackupCfg'), defaultPath: 'winscp-material-config.json' });
      if (!path) return;
      const res = await api.raw?.config?.export?.(path);
      if (!res?.ok) throw new Error(res?.error?.message || 'The configuration could not be written.');
      notify.success(t('cfgExported'), String(res.value || path));
    } catch (err) { notify.error(t('exportBackupCfg'), err.message || String(err)); }
  }

  function importConfiguration() {
    // Replacing the configuration is destructive and irreversible from here,
    // so it is a real decision and gets a real modal.
    openConfirm({
      title: t('importRestoreCfg'),
      body: 'Restoring a configuration replaces the current sites, folders, workspaces and preferences with the ones in the file. A version-history snapshot is taken first, so this can be undone from the history panel.',
      danger: true,
      confirmLabel: t('import_'),
      onConfirm: async () => {
        try {
          const path = await pickLocalPath({ title: t('importRestoreCfg') });
          if (!path) return;
          await api.historyRecord('Before restoring a configuration');
          const res = await api.raw?.config?.import?.(path, `Restored the configuration from ${path}`);
          if (!res?.ok) throw new Error(res?.error?.message || 'The configuration could not be read.');
          notifySitesChanged();
          await tree.refresh();
          notify.success(t('cfgImported'), path);
        } catch (err) { notify.error(t('importRestoreCfg'), err.message || String(err)); }
      },
    });
  }

  /**
   * Clean Up. Every item here deletes something, so the dialog states exactly
   * what each one removes and nothing runs until the user confirms.
   */
  function openCleanUp() {
    const items = [
      { id: 'sites', label: t('cuSites'), description: 'Every stored site, folder and workspace, including their stored passwords.' },
      { id: 'hostKeys', label: t('cuHostKeys'), description: 'Every cached SSH host key. The next connection to each server asks you to verify it again.' },
      { id: 'history', label: t('cuHistory'), description: 'The remembered directories, masks and other combo-box histories.' },
      { id: 'bookmarks', label: 'Bookmarks', description: 'Saved local and remote directory bookmarks.' },
      { id: 'appearance', label: t('cuAppearance'), description: 'Per-element appearance overrides and saved appearance presets. The theme, density and font are kept.' },
      { id: 'searches', label: 'Saved searches', description: 'The remembered query, pattern and mode of every search bar.' },
    ];
    const checked = new Set();
    const rows = items.map((item) => {
      const id = uid('cu');
      const box = h('input', {
        type: 'checkbox', id,
        onchange: () => { if (box.checked) checked.add(item.id); else checked.delete(item.id); },
      });
      return h('label', { class: 'sd-check', for: id }, box,
        h('span', { class: 'sd-check-text' }, item.label,
          h('span', { class: 'sd-hint', style: { display: 'block' } }, item.description)));
    });

    openModal({
      title: t('cleanupTitle'),
      width: 620,
      content: h('div', { class: 'stack' },
        h('p', { class: 'prose' }, t('cleanupBody')),
        ...rows,
        h('div', { class: 'sd-note is-warn' }, icon('warning', 15),
          h('span', {}, 'A version-history snapshot is taken first, so anything removed here can be restored from the history panel.'))),
      actions: [
        { label: t('cancel'), kind: 'text' },
        {
          label: t('cleanUp'), kind: 'danger',
          onSelect: () => { runCleanUp(Array.from(checked)); },
        },
      ],
    });
  }

  async function runCleanUp(selection) {
    if (!selection.length) { notify.warning(t('cleanupTitle'), 'Nothing was selected, so nothing was removed.'); return; }
    await api.historyRecord(`Before cleaning up: ${selection.join(', ')}`);
    const done = [];
    const failed = [];

    for (const what of selection) {
      try {
        if (what === 'sites') {
          const doc = await siteStore.load();
          for (const site of doc.sites || []) await siteStore.removeSite(site.id);
          for (const folder of (doc.folders || []).slice().reverse()) await siteStore.removeFolder(folder, false);
          for (const ws of doc.workspaces || []) await siteStore.removeWorkspace(ws.name || ws);
          done.push(`${(doc.sites || []).length} sites`);
        } else if (what === 'hostKeys') {
          const res = await api.raw?.config?.hostKeys?.();
          const keys = res?.ok ? res.value : {};
          const names = Object.keys(keys || {});
          for (const name of names) await api.raw?.config?.forgetHostKey?.(name);
          done.push(`${names.length} host keys`);
        } else if (what === 'history') {
          await api.raw?.config?.clearHistory?.();
          done.push('combo-box history');
        } else if (what === 'bookmarks') {
          const res = await api.raw?.config?.get?.();
          const bookmarks = res?.ok ? (res.value?.prefs?.bookmarks || {}) : {};
          let removed = 0;
          for (const [key, entry] of Object.entries(bookmarks)) {
            for (const side of ['local', 'remote']) {
              for (const value of entry?.[side] || []) {
                await api.raw?.config?.removeBookmark?.(key, side, value.value || value);
                removed += 1;
              }
            }
          }
          done.push(`${removed} bookmarks`);
        } else if (what === 'appearance') {
          store.set('theme', { ...(store.get('theme') || {}), perElement: {}, presets: [] });
          persistCurrent('theme');
          done.push('appearance overrides');
        } else if (what === 'searches') {
          store.set('search', {});
          persistCurrent('search');
          done.push('saved searches');
        }
      } catch (err) {
        failed.push(`${what}: ${err.message || err}`);
      }
    }

    notifySitesChanged();
    await tree.refresh();
    loadNode(tree.selected);
    if (failed.length) notify.error(t('cleanupTitle'), failed.join('\n'));
    else notify.success(t('cleanupDone'), done.join(', '));
  }

  async function checkForUpdates() {
    try {
      const call = api.raw?.app?.checkUpdates;
      if (!call) { notify.warning(t('checkUpdates'), 'The update check needs the application shell.'); return; }
      notify.info(t('checkUpdates'), 'Checking…');
      const res = await call({ force: true });
      if (!res?.ok) throw new Error(res?.error?.message || 'The update check failed.');
      const info = res.value || {};
      if (info.available) {
        notify.success(t('checkUpdates'), `Version ${info.version || 'newer'} is available.`, {
          actions: info.url ? [{ label: 'Open release notes', onSelect: () => api.openExternal(info.url) }] : [],
        });
      } else {
        notify.success(t('checkUpdates'), t('updatesLatest'));
      }
    } catch (err) { notify.error(t('checkUpdates'), err.message || String(err)); }
  }

  /* ---------------- external tools ---------------- */

  function integrationPath(key, fallback) {
    return state.prefs?.integration?.[key] || fallback;
  }

  async function runLocalProgram(commandLine, label) {
    try {
      const call = api.raw?.app?.runCustomCommand;
      if (!call) { notify.warning(label, 'Running a local program needs the application shell.'); return null; }
      const res = await call({ command: commandLine, local: true, showResults: false });
      if (!res?.ok) throw new Error(res?.error?.message || `${label} could not be started.`);
      notify.success(label, 'Started.');
      return res.value;
    } catch (err) {
      notify.error(label, `${err.message || err} Check the path in Preferences → Integration → Applications.`);
      return null;
    }
  }

  function runExternalTool(prefKey, label) {
    const defaults = {
      puttygenPath: '%PROGRAMFILES%\\PuTTY\\puttygen.exe',
      pageantPath: '%PROGRAMFILES%\\PuTTY\\pageant.exe',
      puttyPath: '%PROGRAMFILES%\\PuTTY\\putty.exe',
    };
    return runLocalProgram(`"${integrationPath(prefKey, defaults[prefKey])}"`, label);
  }

  /**
   * Open in PuTTY. The password is DELIBERATELY not passed: PuTTY's -pw puts it
   * on a command line, which every other process on the machine can read.
   */
  function openInPutty(site, { settingsOnly = false } = {}) {
    const exe = integrationPath('puttyPath', '%PROGRAMFILES%\\PuTTY\\putty.exe');
    const args = [];
    if (settingsOnly && site.puttySettings) {
      args.push('-load', `"${site.puttySettings}"`);
    } else {
      if (site.puttySettings) args.push('-load', `"${site.puttySettings}"`);
      const ftpLikeTelnet = site.protocol === 'ftp' && state.prefs?.integration?.telnetForFtpInPutty !== false;
      args.push(ftpLikeTelnet ? '-telnet' : '-ssh');
      if (site.userName) args.push('-l', `"${site.userName}"`);
      if (site.portNumber) args.push('-P', String(site.portNumber));
      if (site.publicKeyFile) args.push('-i', `"${site.publicKeyFile}"`);
      args.push(`"${site.hostName}"`);
    }
    notify.info(t('openPutty'),
      'The password is not passed to PuTTY: a command line is readable by every process on this machine. PuTTY will ask for it.');
    return runLocalProgram(`"${exe}" ${args.join(' ')}`, t('openPutty'));
  }

  async function installPublicKey(site) {
    if (!site.publicKeyFile) {
      notify.warning(t('installKeyTitle'), 'Choose a private key file first — the public half is derived from it.');
      return;
    }
    openConfirm({
      title: t('installKeyTitle'),
      body: t('installKeyBody'),
      confirmLabel: t('ok'),
      onConfirm: () => {
        notify.info(t('installKeyTitle'),
          'Open the session, then use Commands → Install public key into server. That path runs against the live connection, which is the only place the authorized_keys file can be written.');
      },
    });
  }

  function displayPublicKey(site) {
    if (!site.publicKeyFile) return;
    openModal({
      title: 'Public key',
      width: 640,
      content: h('div', { class: 'stack' },
        h('p', { class: 'prose' },
          `The public half of ${site.publicKeyFile} is derived by the session when it connects, because reading a key file needs the application shell rather than this window.`),
        h('p', { class: 'prose' },
          'Open the session and use Commands → Server and protocol information to see the key the server accepted.')),
      actions: [{ label: t('close'), kind: 'filled', autofocus: true }],
    });
  }

  /**
   * A Windows Internet Shortcut (.url) carrying this site's session URL. Saved
   * through the browser's download path, which is the only local-write route
   * this window has — so it genuinely produces a file the user can drop on the
   * desktop or into the Send To folder.
   */
  function createShortcut(where) {
    const site = currentSiteForOutput();
    if (!site.hostName) { notify.warning('Shortcut', t('hostRequired')); return; }
    const url = buildSessionUrl(site, { userName: true, winscpSpecific: true, remoteDirectory: true });
    const name = (site.name || site.hostName).replace(/[\\/:*?"<>|]/g, '_');
    downloadText(`${name}.url`, `[InternetShortcut]\r\nURL=${url}\r\nIconIndex=0\r\n`, 'application/x-mswinurl');
    notify.success(where === 'desktop' ? 'Desktop icon' : 'Send To shortcut',
      where === 'desktop'
        ? `"${name}.url" was saved. Move it to your Desktop folder to finish. It carries no password.`
        : `"${name}.url" was saved. Move it to shell:sendto to finish. It carries no password.`);
  }

  function openPreferencesPage(page) {
    const opened = openDialog('preferences', { page });
    if (!opened) runCommand('app.preferences');
  }

  /* ---------------- small shared dialogs ---------------- */

  function openConfirm({ title, body, danger, confirmLabel, extraLabel, onConfirm, onExtra }) {
    const actions = [{ label: t('cancel'), kind: 'text' }];
    if (extraLabel) actions.push({ label: extraLabel, kind: 'text', onSelect: () => { onExtra?.(); } });
    actions.push({
      label: confirmLabel || t('ok'),
      kind: danger ? 'danger' : 'filled',
      autofocus: !danger,
      onSelect: () => { onConfirm?.(); },
    });
    return openModal({ title, width: 560, content: h('p', { class: 'prose' }, body), actions });
  }

  function openPrompt({ title, label, value, onSubmit }) {
    const id = uid('lg-prompt');
    const input = h('input', { type: 'text', id, class: 'sd-input' });
    input.value = value || '';
    const modal = openModal({
      title,
      width: 480,
      content: h('div', { class: 'sd-grid' },
        h('label', { class: 'sd-label', for: id }, label),
        input),
      actions: [
        { label: t('cancel'), kind: 'text' },
        { label: t('ok'), kind: 'filled', onSelect: () => { onSubmit?.(input.value.trim()); } },
      ],
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); onSubmit?.(input.value.trim()); modal.close('submit'); }
    });
    requestAnimationFrame(() => { input.focus(); input.select(); });
    return modal;
  }

  async function pickLocalPath(options = {}) {
    try {
      const call = api.raw?.app?.pickPath;
      if (!call) { notify.info(t('browse'), 'The file picker needs the application shell.'); return null; }
      const res = await call(options);
      if (!res?.ok) throw new Error(res?.error?.message || 'The picker was refused.');
      const value = res.value;
      return Array.isArray(value) ? value[0] : value || null;
    } catch (err) { notify.error(t('browse'), err.message || String(err)); return null; }
  }

  /* ---------------- keyboard ---------------- */

  root.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); filterBar.focus(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); doSave(e.shiftKey); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') { e.preventDefault(); openAdvanced(); }
  });

  const offI18n = bindRender(root, () => { paintModeChip(); renderForm(); });

  renderForm();

  return {
    element: root,
    get site() { return { ...state.site }; },
    tree,
    login: doLogin,
    save: doSave,
    openAdvanced,
    pasteSessionUrl,
    refresh: () => tree.refresh(),
    destroy() {
      offI18n?.();
      filterBar.destroy();
      tree.destroy();
      root.remove();
    },
  };
}

/** A base64 key with real entropy from the platform CSPRNG. */
function randomBase64Key(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let binary = '';
  for (const b of buf) binary += String.fromCharCode(b);
  return btoa(binary);
}

/* ================================================================== */
/* registration                                                        */
/* ================================================================== */

let livePanel = null;
let installed = false;

/**
 * Registration is deferred rather than run at module scope. This module
 * imports app.js and app.js may well end up importing this one; ES module
 * evaluation order would then run registerDialog() while app.js's own
 * registries are still in their temporal dead zone. A microtask puts the call
 * after both module bodies, which is the pattern every dialog here follows.
 */
export function registerLoginDialog() {
  if (installed) return;
  installed = true;

  registerDialog('login', ({ props, close }) => {
    const panel = createLoginPanel({
      prefs: props.prefs,
      onLogin: (info) => {
        props.onLogin?.(info);
        panel.destroy();
        close('login');
      },
      onClose: () => { panel.destroy(); close('close'); },
    });
    livePanel = panel;
    return {
      title: t('loginTitle'),
      width: 1040,
      content: panel.element,
      actions: [],               // the panel draws its own buttons, as the original does
      onClose: () => { if (livePanel === panel) livePanel = null; panel.destroy(); },
    };
  });

  registerCommand({
    id: 'session.siteManager', labelKey: 'newConnection', icon: 'add_link', shortcut: 'Ctrl+N',
    run: () => openLogin(),
  });

  registerTitlebarAction({
    id: 'new-connection', icon: 'add_link', labelKey: 'newConnection', order: 5,
    showLabel: true,
    onSelect: () => openLogin(),
  });

  // Other surfaces need a route to this dialog without importing it.
  bus.emit('login:registered', { id: 'login' });
}

/** Open the Login / Site Manager dialog. */
export function openLogin(props = {}) {
  registerLoginDialog();
  const targetWorkspace = props.workspace || appSession.get('workspace');
  const onLogin = props.onLogin || ((info) => {
    bus.emit('session:opened', info);
    targetWorkspace?.attachSession(info);
  });
  return openDialog('login', { ...props, onLogin });
}

if (typeof document !== 'undefined') {
  queueMicrotask(() => {
    try { registerLoginDialog(); } catch (err) { console.error('[login] registration failed', err); }
  });
}

export { bindText };
