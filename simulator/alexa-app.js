// The simulated Alexa app (runs in the phone frame of the simulator, same origin). It plays Alexa's side of account
// linking exactly as Amazon describes it: Alexa holds the PKCE verifier, sends the person to Mandat's authorization
// page, gets the code back on its redirect URI, exchanges it at the token endpoint, keeps the tokens, then asks the
// customer-data permissions. Views: notify (lock screen) -> addon -> [Mandat's page] -> linked -> permissions -> done;
// and manage (permissions, unlink, delete data). It talks to the simulator page with postMessage (same origin only).
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
const session = { get(k) { try { return JSON.parse(sessionStorage.getItem(k)); } catch { return null; } }, del(k) { try { sessionStorage.removeItem(k); } catch {} } };
const CLIENT = 'alexa-plus-simulator';
const params = new URLSearchParams(location.search);
const theme = params.get('theme') || store.get('mandat.theme', null);
if (theme) document.documentElement.dataset.theme = theme;
const lang = (params.get('lang') || store.get('mandat.lang', 'en-US') || 'en-US').slice(0, 2);
document.documentElement.lang = lang;
const post = (type, data = {}) => { try { parent.postMessage({ source: 'alexa-app', type, ...data }, location.origin); } catch {} };

// The Alexa profile the person shares (simulated: a demo Amazon account).
export const PROFILE = { name: { full: 'Alex Rivera', given: 'Alex' }, email: 'alex.rivera@example.com', address: { line1: 'Capitol Hill', city: 'Seattle', region: 'WA', postal: '98102' } };

const T = {
  en: {
    sim: 'Alexa app · simulated', now: 'now', notifTitle: 'Link Mandat', notifBody: 'Finish setting up Mandat: link your account and choose what to share.', tapHint: 'Tap the notification',
    addons: 'Add-ons', tagline: 'Household errands inside a budget', by: 'by Blanco', link: 'Link account', canDo: 'What Mandat does',
    do1: 'Finds and books home services and products', do2: 'Negotiates with merchants’ agents', do3: 'Never spends above the rules you set',
    needs: 'Account linking', needsNote: 'Mandat needs your Mandat account. You will sign in on Mandat’s own page.', perms: 'It may ask for', permsList: 'Name, email, address',
    linkedTitle: 'Mandat is linked', linkedSub: 'Next, choose what Mandat may use.',
    pTitle: 'Mandat would like to use', pLead: 'Alexa shares only what you allow. You can change it anytime in Manage.',
    name: 'Name', email: 'Email', address: 'Address', whyName: 'To greet you', whyEmail: 'For receipts (this demo sends no email)', whyAddress: 'To book services at home and deliver',
    allow: 'Allow', notNow: 'Not now', doneTitle: 'You’re all set', doneShow: 'Continue on your Echo Show.', doneDot: 'Alexa will ask you a few questions.',
    failTitle: 'Linking did not finish', failSub: 'Nothing was shared. Try again from the Echo Show.', back: 'Back', close: 'Close',
    manage: 'Manage', checking: 'Checking the link…', expired: 'Link expired', relink: 'Link again', unknownState: 'Link state unknown: try again in a moment', linked: 'Linked', notLinked: 'Not linked', unlink: 'Unlink Mandat', unlinkQ: 'Unlink Mandat? Alexa stops using your Mandat account and every access token is revoked. Your Mandat data stays until you delete it.', del: 'Delete my Mandat data', delQ: 'Delete everything Mandat knows about this household? Open payment holds are voided first. This cannot be undone.', cancel: 'Cancel', confirmUnlink: 'Unlink', confirmDel: 'Delete', shared: 'Shared with Mandat', account: 'Account', since: 'Linked {d}', unlinked: 'Mandat is unlinked', enableAgain: 'Say “Alexa, enable Mandat” to link it again.',
  },
  fr: {
    sim: 'App Alexa · simulée', now: 'maintenant', notifTitle: 'Lier Mandat', notifBody: 'Terminez la configuration de Mandat : liez votre compte et choisissez ce que vous partagez.', tapHint: 'Touchez la notification',
    addons: 'Extensions', tagline: 'Les courses du foyer, dans un budget', by: 'par Blanco', link: 'Lier le compte', canDo: 'Ce que fait Mandat',
    do1: 'Trouve et réserve services et produits pour la maison', do2: 'Négocie avec les agents des commerçants', do3: 'Ne dépense jamais au-delà de vos règles',
    needs: 'Liaison de compte', needsNote: 'Mandat a besoin de votre compte Mandat. Vous vous connectez sur la page de Mandat.', perms: 'Peut demander', permsList: 'Nom, e-mail, adresse',
    linkedTitle: 'Mandat est lié', linkedSub: 'Choisissez maintenant ce que Mandat peut utiliser.',
    pTitle: 'Mandat souhaite utiliser', pLead: 'Alexa ne partage que ce que vous autorisez. Modifiable à tout moment dans Gérer.',
    name: 'Nom', email: 'E-mail', address: 'Adresse', whyName: 'Pour vous saluer', whyEmail: 'Pour les reçus (cette démo n’envoie aucun e-mail)', whyAddress: 'Pour réserver à domicile et livrer',
    allow: 'Autoriser', notNow: 'Plus tard', doneTitle: 'C’est prêt', doneShow: 'Continuez sur votre Echo Show.', doneDot: 'Alexa va vous poser quelques questions.',
    failTitle: 'La liaison n’a pas abouti', failSub: 'Rien n’a été partagé. Réessayez depuis l’Echo Show.', back: 'Retour', close: 'Fermer',
    manage: 'Gérer', checking: 'Vérification du lien…', expired: 'Lien expiré', relink: 'Relier', unknownState: 'État du lien inconnu : réessayez dans un instant', linked: 'Lié', notLinked: 'Non lié', unlink: 'Délier Mandat', unlinkQ: 'Délier Mandat ? Alexa n’utilise plus votre compte Mandat et tous les jetons sont révoqués. Vos données Mandat restent jusqu’à leur suppression.', del: 'Supprimer mes données Mandat', delQ: 'Supprimer tout ce que Mandat sait de ce foyer ? Les paiements réservés sont d’abord annulés. C’est définitif.', cancel: 'Annuler', confirmUnlink: 'Délier', confirmDel: 'Supprimer', shared: 'Partagé avec Mandat', account: 'Compte', since: 'Lié {d}', unlinked: 'Mandat est délié', enableAgain: 'Dites « Alexa, active Mandat » pour le lier à nouveau.',
  },
  es: {
    sim: 'App de Alexa · simulada', now: 'ahora', notifTitle: 'Vincular Mandat', notifBody: 'Termina de configurar Mandat: vincula tu cuenta y elige qué compartes.', tapHint: 'Toca la notificación',
    addons: 'Extensiones', tagline: 'Los recados de casa, dentro de un presupuesto', by: 'de Blanco', link: 'Vincular cuenta', canDo: 'Qué hace Mandat',
    do1: 'Busca y reserva servicios y productos para casa', do2: 'Negocia con los agentes de los comercios', do3: 'Nunca gasta por encima de tus reglas',
    needs: 'Vinculación de cuenta', needsNote: 'Mandat necesita tu cuenta de Mandat. Inicias sesión en la propia página de Mandat.', perms: 'Puede pedir', permsList: 'Nombre, correo, dirección',
    linkedTitle: 'Mandat está vinculado', linkedSub: 'Ahora elige qué puede usar Mandat.',
    pTitle: 'Mandat quiere usar', pLead: 'Alexa solo comparte lo que permitas. Puedes cambiarlo cuando quieras en Gestionar.',
    name: 'Nombre', email: 'Correo', address: 'Dirección', whyName: 'Para saludarte', whyEmail: 'Para los recibos (esta demo no envía correos)', whyAddress: 'Para reservar en casa y hacer envíos',
    allow: 'Permitir', notNow: 'Ahora no', doneTitle: 'Todo listo', doneShow: 'Sigue en tu Echo Show.', doneDot: 'Alexa te hará unas preguntas.',
    failTitle: 'La vinculación no terminó', failSub: 'No se compartió nada. Vuelve a intentarlo desde el Echo Show.', back: 'Volver', close: 'Cerrar',
    manage: 'Gestionar', checking: 'Comprobando el vínculo…', expired: 'Vínculo caducado', relink: 'Volver a vincular', unknownState: 'Estado del vínculo desconocido: inténtalo en un momento', linked: 'Vinculado', notLinked: 'No vinculado', unlink: 'Desvincular Mandat', unlinkQ: '¿Desvincular Mandat? Alexa deja de usar tu cuenta de Mandat y se revocan todos los tokens. Tus datos de Mandat siguen hasta que los borres.', del: 'Borrar mis datos de Mandat', delQ: '¿Borrar todo lo que Mandat sabe de este hogar? Primero se anulan las retenciones. No se puede deshacer.', cancel: 'Cancelar', confirmUnlink: 'Desvincular', confirmDel: 'Borrar', shared: 'Compartido con Mandat', account: 'Cuenta', since: 'Vinculado {d}', unlinked: 'Mandat está desvinculado', enableAgain: 'Di «Alexa, activa Mandat» para vincularlo de nuevo.',
  },
};
const t = (k, v = {}) => (T[lang]?.[k] ?? T.en[k] ?? k).replace(/\{(\w+)\}/g, (_, x) => v[x] ?? '');
const MARK = '<span class="mark" aria-hidden="true"><svg viewBox="0 0 512 512" aria-hidden="true"><rect width="512" height="512" rx="114" fill="#141519"/><circle cx="238" cy="238" r="98" fill="none" stroke="#f4f1ec" stroke-width="50"/><circle cx="362" cy="362" r="49" fill="#ffc439"/></svg></span>'; // Mandat's own logo (media/brand/icon.svg)
const BUBBLE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 1 4.2 7l-3.7 1 1-3.4A8 8 0 0 1 4 12Z"/></svg>';
const CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5 10 17 19 7"/></svg>';
const bar = (back) => `<header class="bar">${back ? `<button class="ui-button ui-button--plain" id="back" type="button">‹ ${esc(t(back))}</button>` : ''}<span class="sim">${esc(t('sim'))}</span></header>`;
const show = (html) => { $('#app').innerHTML = html; $('#app').querySelector('h1, button')?.focus?.({ preventScroll: true }); };

function lock() {
  const now = new Date();
  document.body.style.background = '#101114';
  $('#app').innerHTML = `<section class="lock" aria-label="${esc(t('notifTitle'))}">
    <div class="time">${now.toLocaleTimeString(lang, { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M$/i, '')}</div>
    <div class="date">${esc(now.toLocaleDateString(lang, { weekday: 'long', month: 'long', day: 'numeric' }))}</div>
    <button class="notif" id="notif" type="button"><span class="ico">${BUBBLE}</span><span><b>Alexa<small>${esc(t('now'))}</small></b><span><b>${esc(t('notifTitle'))}</b></span><span>${esc(t('notifBody'))}</span></span></button>
    <p class="hint">${esc(t('tapHint'))}</p></section>`;
  $('#notif').onclick = addon;
}
function addon() {
  document.body.style.background = '';
  const pending = session.get('mandat.link.pending');
  show(`${bar('addons')}<section class="view">
    <div class="app-head">${MARK}<div><b>Mandat</b><span>${esc(t('tagline'))} · ${esc(t('by'))}</span></div></div>
    <div class="actions"><button class="ui-button ui-button--prominent big" id="link" type="button">${esc(t('link'))}</button></div>
    <div><h2>${esc(t('canDo'))}</h2><div class="group">${['do1', 'do2', 'do3'].map((k) => `<div class="row"><b>${esc(t(k))}</b></div>`).join('')}</div></div>
    <div><h2>${esc(t('needs'))}</h2><div class="group"><div class="row"><span>${esc(t('needsNote'))}</span></div><div class="row"><b>${esc(t('perms'))}</b><span>${esc(t('permsList'))}</span></div></div></div>
  </section>`);
  $('#back').onclick = lock;
  $('#link').onclick = () => {
    if (!pending?.authorizeUrl) return fail('no pending link');
    post('step', { step: 'signin' });
    location.href = pending.authorizeUrl; // Mandat's own page (OAuth authorization endpoint)
  };
}
function fail(why) {
  post('failed', { reason: String(why || '') });
  show(`${bar()}<section class="view ok"><h1>${esc(t('failTitle'))}</h1><p class="lead">${esc(t('failSub'))}</p><button class="ui-button" id="close" type="button">${esc(t('close'))}</button></section>`);
  $('#close').onclick = () => post('close');
}

// Back from Mandat's page with ?code=…&state=… (or ?error=…): Alexa's side of the token exchange.
async function finish() {
  const pending = session.get('mandat.link.pending');
  if (params.get('error')) { session.del('mandat.link.pending'); return fail(params.get('error')); }
  if (!pending || params.get('state') !== pending.state) return fail('state mismatch');
  const body = new URLSearchParams({ grant_type: 'authorization_code', code: params.get('code'), redirect_uri: location.origin + location.pathname, client_id: CLIENT, code_verifier: pending.verifier, resource: pending.resource });
  try {
    const r = await fetch('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    const tok = await r.json();
    if (!r.ok) return fail(tok.error_description || tok.error);
    // Alexa keeps the tokens (here: this browser's storage) and attaches the access token to every add-on request.
    store.set('mandat.link', { access_token: tok.access_token, refresh_token: tok.refresh_token, expires_at: Date.now() + tok.expires_in * 1000, scope: tok.scope, linked_at: new Date().toISOString() });
    session.del('mandat.link.pending');
    history.replaceState(null, '', location.pathname + '?lang=' + lang + (theme ? '&theme=' + theme : '')); // the code never stays in the address bar
    post('linked');
    show(`${bar()}<section class="view ok"><span class="tick">${CHECK}</span><h1>${esc(t('linkedTitle'))}</h1><p class="lead">${esc(t('linkedSub'))}</p></section>`);
    setTimeout(() => permissions({ firstRun: true, device: pending.device }), 1100);
  } catch (e) { fail(e.message); }
}

// The customer-data permission screen (one switch per item, all on by default, as Alexa proposes).
function permissions({ firstRun = false, device = 'show' } = {}) {
  const granted = store.get('mandat.permissions', { name: true, email: true, address: true });
  const val = { name: PROFILE.name.full, email: PROFILE.email, address: `${PROFILE.address.line1}, ${PROFILE.address.city}, ${PROFILE.address.region} ${PROFILE.address.postal}` };
  const why = { name: 'whyName', email: 'whyEmail', address: 'whyAddress' };
  show(`${bar(firstRun ? null : 'manage')}<section class="view">
    <div class="app-head">${MARK}<div><b>${esc(t('pTitle'))}</b></div></div>
    <p class="lead">${esc(t('pLead'))}</p>
    <div class="group" role="group" aria-label="${esc(t('pTitle'))}">${['name', 'email', 'address'].map((k) => `<label class="row"><span><b>${esc(t(k))}</b><span class="val">${esc(val[k])}</span><small>${esc(t(why[k]))}</small></span><input class="ui-switch" type="checkbox" data-k="${k}" ${granted[k] ? 'checked' : ''} aria-label="${esc(t(k))}"></label>`).join('')}</div>
    <div class="actions"><button class="ui-button ui-button--prominent big" id="allow" type="button">${esc(t('allow'))}</button>${firstRun ? `<button class="ui-button ui-button--plain" id="later" type="button">${esc(t('notNow'))}</button>` : ''}</div>
  </section>`);
  const back = $('#back'); if (back) back.onclick = manage;
  const send = (g) => {
    store.set('mandat.permissions', g);
    post('permissions', { granted: g, values: { name: g.name ? PROFILE.name : undefined, email: g.email ? PROFILE.email : undefined, address: g.address ? PROFILE.address : undefined }, firstRun });
    if (firstRun) done(device); else manage();
  };
  $('#allow').onclick = () => send(Object.fromEntries([...document.querySelectorAll('[data-k]')].map((i) => [i.dataset.k, i.checked])));
  const later = $('#later'); if (later) later.onclick = () => send({ name: false, email: false, address: false });
}
function done(device) {
  show(`${bar()}<section class="view ok"><span class="tick">${CHECK}</span><h1>${esc(t('doneTitle'))}</h1><p class="lead">${esc(t(device === 'dot' ? 'doneDot' : 'doneShow'))}</p></section>`);
  setTimeout(() => post('close'), 1400);
}

// The real state of the link: an authenticated call; an expired access token is renewed once (one refresh at a time
// across tabs, the shared copy read again first); a refused refresh means the link is gone.
async function checkLink(link) {
  const probe = (l) => fetch(`/activity?turn=check-${Date.now()}`, { headers: { authorization: `Bearer ${l.access_token}` }, cache: 'no-store' }).then((r) => r.status);
  try {
    if ((await probe(link)) === 200) return 'linked';
    const renew = async () => {
      const cur = store.get('mandat.link', null) || link;
      if (cur.access_token !== link.access_token && (await probe(cur)) === 200) return 'linked';
      const r = await fetch('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: cur.refresh_token, client_id: CLIENT }) });
      if (!r.ok) return r.status === 400 ? 'expired' : 'unknown';
      const tok = await r.json();
      store.set('mandat.link', { ...cur, access_token: tok.access_token, refresh_token: tok.refresh_token, expires_at: Date.now() + tok.expires_in * 1000, scope: tok.scope });
      return 'linked';
    };
    return navigator.locks?.request ? await navigator.locks.request('mandat-refresh', renew) : await renew();
  } catch { return 'unknown'; }
}

// Manage (Alexa app > Mandat > Manage): linked state, permissions, unlink, delete data.
function manage(confirm = null) {
  const link = store.get('mandat.link', null);
  const g = store.get('mandat.permissions', { name: false, email: false, address: false });
  const shared = ['name', 'email', 'address'].filter((k) => g[k]).map((k) => t(k)).join(', ') || '—';
  const when = link?.linked_at ? new Date(link.linked_at).toLocaleDateString(lang, { month: 'short', day: 'numeric' }) : '';
  show(`${bar()}<section class="view">
    <div class="app-head">${MARK}<div><b>Mandat</b><span>${esc(t('manage'))}</span></div></div>
    <div><h2>${esc(t('account'))}</h2><div class="group"><div class="row" id="linkState"><b>${esc(t(link ? 'checking' : 'notLinked'))}</b><span></span></div></div></div>
    ${link ? `<div><h2>${esc(t('shared'))}</h2><div class="group"><button class="row" id="perms" type="button"><b>${esc(shared)}</b><span>›</span></button></div></div>
    <div class="group">${confirm === 'unlink' ? `<div class="confirm"><p>${esc(t('unlinkQ'))}</p><div class="actions"><button class="ui-button" id="no" type="button">${esc(t('cancel'))}</button><button class="ui-button ui-button--destructive" id="yes" type="button">${esc(t('confirmUnlink'))}</button></div></div>`
      : `<button class="row" id="unlink" type="button"><b class="danger">${esc(t('unlink'))}</b></button>`}</div>
    <div class="group">${confirm === 'delete' ? `<div class="confirm"><p>${esc(t('delQ'))}</p><div class="actions"><button class="ui-button" id="no" type="button">${esc(t('cancel'))}</button><button class="ui-button ui-button--destructive" id="yes" type="button">${esc(t('confirmDel'))}</button></div></div>`
      : `<button class="row" id="delete" type="button"><b class="danger">${esc(t('del'))}</b></button>`}</div>` : `<p class="note">${esc(t('enableAgain'))}</p>`}
    <div class="actions"><button class="ui-button" id="close" type="button">${esc(t('close'))}</button></div>
  </section>`);
  const on = (id, fn) => { const e = $('#' + id); if (e) e.onclick = fn; };
  // never "Linked" on trust: ask the server with the link (and renew it if its access token just expired)
  if (link) checkLink(link).then((state) => {
    const row = $('#linkState'); if (!row) return;
    if (state === 'linked') row.innerHTML = `<b>${esc(t('linked'))}</b><span>${esc(when ? t('since', { d: when }) : '')}</span>`;
    else if (state === 'expired') { row.innerHTML = `<b class="danger">${esc(t('expired'))}</b><button class="ui-button ui-button--filled relink" id="relink" type="button">${esc(t('relink'))}</button>`; on('relink', () => post('relink')); }
    else row.innerHTML = `<b>${esc(t('unknownState'))}</b>`;
  });
  on('perms', () => permissions());
  on('unlink', () => manage('unlink'));
  on('delete', () => manage('delete'));
  on('no', () => manage());
  on('close', () => post('close'));
  on('yes', async () => {
    if (confirm === 'unlink') {
      // RFC 7009 revocation: the whole link goes (access and refresh tokens)
      try { await fetch('/oauth/revoke', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: link.refresh_token, token_type_hint: 'refresh_token', client_id: CLIENT }) }); } catch {}
      store.del('mandat.link'); store.del('mandat.permissions');
      post('unlinked');
      show(`${bar()}<section class="view ok"><h1>${esc(t('unlinked'))}</h1><p class="lead">${esc(t('enableAgain'))}</p></section>`);
      setTimeout(() => post('close'), 1600);
    } else {
      post('delete'); // the page calls delete_my_data with this link's token, then forgets the link
    }
  });
}

if (params.get('code') || params.get('error')) finish();
else if (params.get('view') === 'manage') manage();
else if (params.get('view') === 'permissions') permissions();
else if (params.get('view') === 'addon') addon();
else lock();
