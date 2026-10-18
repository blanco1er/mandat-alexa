// The simulator in the user's language: English (default), French, Spanish. Keys are the English strings.
// The MCP traffic drawer stays in English (it is a developer console). Cards localise themselves from
// hostContext.locale; the server speaks the locale the page sends with each turn.
export const LANGS = [
  { code: 'en-US', label: 'EN', name: 'English' },
  { code: 'fr-FR', label: 'FR', name: 'Français' },
  { code: 'es-ES', label: 'ES', name: 'Español' },
];
export function pickLocale(pref, navLangs = []) {
  const ok = (l) => { const s = String(l || '').toLowerCase(); return s.startsWith('fr') ? 'fr-FR' : s.startsWith('es') ? 'es-ES' : s.startsWith('en') ? 'en-US' : null; };
  if (ok(pref)) return ok(pref);
  for (const l of navLangs) if (ok(l)) return ok(l);
  return 'en-US';
}

const T = {
  fr: {
    'Alexa+ add-on simulator': 'Simulateur d’extension Alexa+', Device: 'Appareil', Language: 'Langue',
    'Dark appearance': 'Apparence sombre', 'Light appearance': 'Apparence claire', 'Light or dark appearance': 'Apparence claire ou sombre', 'New household': 'Nouveau foyer', 'Start a fresh household': 'Recommencer avec un nouveau foyer', 'MCP traffic': 'Trafic MCP', 'MCP traffic (D)': 'Trafic MCP (D)',
    'Simulated device': 'Appareil simulé', 'Checking your household…': 'Je vérifie la maison…', 'Working on it': 'Je m’en occupe', Done: 'C’est fait', 'What Alexa is doing': 'Ce que fait Alexa', 'What Alexa did': 'Ce qu’a fait Alexa',
    'Say “yes” to confirm': 'Dites « oui » pour confirmer', 'Say “yes” to confirm {amt}': 'Dites « oui » pour confirmer {amt}', 'Captions for this demo. The Echo Dot has no screen.': 'Sous-titres de la démo. L’Echo Dot n’a pas d’écran.',
    'Talk to Alexa': 'Parler à Alexa', 'Stop listening': 'Arrêter l’écoute', 'Tap to talk': 'Touchez pour parler', 'Listening…': 'J’écoute…', 'Thinking…': 'Je réfléchis…', 'Alexa is speaking': 'Alexa parle', 'Waiting for your yes': 'J’attends votre oui',
    'Or press {kbd}. Voice works in Chrome; typing works everywhere.': 'Ou appuyez sur {kbd}. La voix marche dans Chrome ; le texte partout.', 'Or type what you would say': 'Ou écrivez ce que vous diriez', 'Alexa, how much is left?': 'Alexa, il reste combien ?', Send: 'Envoyer', Sending: 'Envoi',
    'Demo script': 'Script de démo', 'Unofficial Alexa+ simulator. No real money.': 'Simulateur Alexa+ non officiel. Aucun argent réel.', Next: 'Suivant', 'Said: ': 'Dit : ', 'Next: ': 'Suivant : ',
    'This browser cannot hear you. Type instead, or open the page in Chrome.': 'Ce navigateur ne vous entend pas. Écrivez, ou ouvrez la page dans Chrome.', 'Microphone blocked. Allow it in the address bar, or type below.': 'Micro bloqué. Autorisez-le dans la barre d’adresse, ou écrivez ci-dessous.',
    'I could not reach Mandat, so nothing was booked or charged. Try again in a moment.': 'Je n’ai pas pu joindre Mandat : rien n’a été réservé ni débité. Réessayez dans un instant.',
    'Unofficial Alexa+ simulator. Brain: {brain}; {pay}. No real money.': 'Simulateur Alexa+ non officiel. Cerveau : {brain} ; {pay}. Aucun argent réel.', 'Amazon Nova 2 Lite on Bedrock': 'Amazon Nova 2 Lite sur Bedrock', 'a scripted demo brain': 'un cerveau de démo scripté', 'payments are simulated (PayPal sandbox not connected)': 'paiements simulés (PayPal sandbox non connecté)', 'PayPal sandbox (test money)': 'PayPal sandbox (argent de test)',
    'No budget yet': 'Pas encore de budget', 'Give Alexa a weekly budget and a rule for small buys.': 'Donnez à Alexa un budget hebdomadaire et une règle pour les petits achats.', 'Try “{x}”': 'Essayez « {x} »', 'Try “Alexa, how much is left?”': 'Essayez « Alexa, il reste combien ? »', 'Try “Alexa, my in-laws land Saturday…”': 'Essayez « Alexa, mes beaux-parents arrivent samedi… »',
    '{amt} left': '{amt} restants', 'this week': 'cette semaine', 'this month': 'ce mois-ci', left: 'restants', '{n} plan waiting for your yes': '{n} plan attend votre oui', '{n} plans waiting for your yes': '{n} plans attendent votre oui', '{n} payment on hold': '{n} paiement réservé', '{n} payments on hold': '{n} paiements réservés', 'Buys on its own under {amt}': 'Achète seule sous {amt}', 'Always asks before paying': 'Demande toujours avant de payer',
    Offline: 'Hors ligne', 'Cannot reach the Mandat MCP server.': 'Impossible de joindre le serveur MCP Mandat.', 'Start it with “npm run demo”, then reload this page.': 'Lancez-le avec « npm run demo », puis rechargez la page.',
    '{n} cleaner asked': '{n} entreprise de ménage contactée', '{n} cleaners asked': '{n} entreprises de ménage contactées', '{n} caterer asked': '{n} traiteur contacté', '{n} caterers asked': '{n} traiteurs contactés', '{n} plumber asked': '{n} plombier contacté', '{n} plumbers asked': '{n} plombiers contactés', '{n} handyman asked': '{n} bricoleur contacté', '{n} handymen asked': '{n} bricoleurs contactés', '{n} pros asked': '{n} professionnels contactés',
    'Stopped: needs a change': 'Arrêté : un changement est nécessaire', 'Saved to memory': 'Gardé en mémoire', 'Checked the budget': 'Budget vérifié', 'Budget {amt}': 'Budget {amt}', '{n} {noun} asked': '{n} {noun} contactés', 'Products · {n} skipped': 'Produits · {n} écartés', 'Products checked': 'Produits comparés', Negotiated: 'Négocié',
    'Opened {name}': 'Ouvert : {name}', '{n} other options': '{n} autres options', 'Compared {n}': '{n} comparés', 'Plan now {amt}': 'Plan à {amt}', Plan: 'Plan', 'Plan {amt}': 'Plan {amt}', ' · auto': ' · auto', '{n} payment hold': '{n} paiement réservé', '{n} payment holds': '{n} paiements réservés',
    '{m} declined · hold voided': '{m} refuse · réservation annulée', '{m} moved': '{m} a déplacé', Refunded: 'Remboursé', Paid: 'Payé', Released: 'Libéré', 'Payment updated': 'Paiement mis à jour',
    cleaners: 'entreprises de ménage', caterers: 'traiteurs', plumbers: 'plombiers', handymen: 'bricoleurs', pros: 'professionnels', cleaner: 'entreprise de ménage', caterer: 'traiteur', plumber: 'plombier', handyman: 'bricoleur',
    'Alexa app': 'App Alexa', 'Open the Alexa app (simulated)': 'Ouvrir l’app Alexa (simulée)', 'Start over': 'Recommencer', 'Unlink and start over': 'Délier et recommencer',
    'Link Mandat': 'Lier Mandat', 'Finish in the Alexa app on your phone': 'Terminez dans l’app Alexa sur votre téléphone', 'Sign in to Mandat': 'Se connecter à Mandat', 'Choose what to share': 'Choisir ce que vous partagez', 'Set your rules': 'Fixer vos règles',
    'Alexa sent a notification to your phone. Mandat never sees your Amazon password.': 'Alexa a envoyé une notification sur votre téléphone. Mandat ne voit jamais votre mot de passe Amazon.',
    'Linking did not finish. Nothing was shared.': 'La liaison n’a pas abouti. Rien n’a été partagé.',
    'To use Mandat, link your account. I sent a notification to your Alexa app.': 'Pour utiliser Mandat, liez votre compte. J’ai envoyé une notification dans votre app Alexa.',
    'Mandat is already enabled. Say “open Mandat settings” to change your rules.': 'Mandat est déjà activé. Dites « ouvre les réglages de Mandat » pour changer vos règles.',
    'Mandat is unlinked. Say “Alexa, enable Mandat” to link it again.': 'Mandat est délié. Dites « Alexa, active Mandat » pour le lier à nouveau.',
    'Mandat is not enabled yet': 'Mandat n’est pas encore activé', 'Say “Alexa, enable Mandat” to link your account and set your rules.': 'Dites « Alexa, active Mandat » pour lier votre compte et fixer vos règles.', 'Try “Alexa, enable Mandat.”': 'Essayez « Alexa, active Mandat. »', 'Not linked': 'Non lié',
    'Alexa app on your phone (simulated)': 'App Alexa sur votre téléphone (simulée)', 'Close the Alexa app': 'Fermer l’app Alexa',
    Settings: 'Réglages', 'Settings saved': 'Réglages enregistrés', 'Mandat paused': 'Mandat en pause', 'Mandat resumed': 'Mandat reprend', 'Data deleted': 'Données supprimées', 'Details shared': 'Coordonnées partagées', Linked: 'Lié', 'Say “yes, delete it” to confirm': 'Dites « oui, supprime » pour confirmer',
    'Shared details updated.': 'Coordonnées partagées mises à jour.',
  },
  es: {
    'Alexa+ add-on simulator': 'Simulador de extensión Alexa+', Device: 'Dispositivo', Language: 'Idioma',
    'Dark appearance': 'Apariencia oscura', 'Light appearance': 'Apariencia clara', 'Light or dark appearance': 'Apariencia clara u oscura', 'New household': 'Nuevo hogar', 'Start a fresh household': 'Empezar con un hogar nuevo', 'MCP traffic': 'Tráfico MCP', 'MCP traffic (D)': 'Tráfico MCP (D)',
    'Simulated device': 'Dispositivo simulado', 'Checking your household…': 'Revisando la casa…', 'Working on it': 'Trabajando en ello', Done: 'Hecho', 'What Alexa is doing': 'Lo que hace Alexa', 'What Alexa did': 'Lo que hizo Alexa',
    'Say “yes” to confirm': 'Di «sí» para confirmar', 'Say “yes” to confirm {amt}': 'Di «sí» para confirmar {amt}', 'Captions for this demo. The Echo Dot has no screen.': 'Subtítulos de la demo. El Echo Dot no tiene pantalla.',
    'Talk to Alexa': 'Hablar con Alexa', 'Stop listening': 'Dejar de escuchar', 'Tap to talk': 'Toca para hablar', 'Listening…': 'Escuchando…', 'Thinking…': 'Pensando…', 'Alexa is speaking': 'Alexa está hablando', 'Waiting for your yes': 'Esperando tu sí',
    'Or press {kbd}. Voice works in Chrome; typing works everywhere.': 'O pulsa {kbd}. La voz funciona en Chrome; escribir, en todas partes.', 'Or type what you would say': 'O escribe lo que dirías', 'Alexa, how much is left?': 'Alexa, ¿cuánto queda?', Send: 'Enviar', Sending: 'Enviando',
    'Demo script': 'Guion de la demo', 'Unofficial Alexa+ simulator. No real money.': 'Simulador no oficial de Alexa+. Sin dinero real.', Next: 'Siguiente', 'Said: ': 'Dicho: ', 'Next: ': 'Siguiente: ',
    'This browser cannot hear you. Type instead, or open the page in Chrome.': 'Este navegador no te oye. Escribe, o abre la página en Chrome.', 'Microphone blocked. Allow it in the address bar, or type below.': 'Micrófono bloqueado. Permítelo en la barra de direcciones o escribe abajo.',
    'I could not reach Mandat, so nothing was booked or charged. Try again in a moment.': 'No pude contactar con Mandat, así que no se reservó ni cobró nada. Inténtalo en un momento.',
    'Unofficial Alexa+ simulator. Brain: {brain}; {pay}. No real money.': 'Simulador no oficial de Alexa+. Cerebro: {brain}; {pay}. Sin dinero real.', 'Amazon Nova 2 Lite on Bedrock': 'Amazon Nova 2 Lite en Bedrock', 'a scripted demo brain': 'un cerebro de demo guionizado', 'payments are simulated (PayPal sandbox not connected)': 'pagos simulados (PayPal sandbox sin conectar)', 'PayPal sandbox (test money)': 'PayPal sandbox (dinero de prueba)',
    'No budget yet': 'Sin presupuesto todavía', 'Give Alexa a weekly budget and a rule for small buys.': 'Dale a Alexa un presupuesto semanal y una regla para compras pequeñas.', 'Try “{x}”': 'Prueba «{x}»', 'Try “Alexa, how much is left?”': 'Prueba «Alexa, ¿cuánto queda?»', 'Try “Alexa, my in-laws land Saturday…”': 'Prueba «Alexa, mis suegros llegan el sábado…»',
    '{amt} left': 'quedan {amt}', 'this week': 'esta semana', 'this month': 'este mes', left: 'quedan', '{n} plan waiting for your yes': '{n} plan espera tu sí', '{n} plans waiting for your yes': '{n} planes esperan tu sí', '{n} payment on hold': '{n} pago retenido', '{n} payments on hold': '{n} pagos retenidos', 'Buys on its own under {amt}': 'Compra sola por debajo de {amt}', 'Always asks before paying': 'Siempre pregunta antes de pagar',
    Offline: 'Sin conexión', 'Cannot reach the Mandat MCP server.': 'No se puede contactar con el servidor MCP de Mandat.', 'Start it with “npm run demo”, then reload this page.': 'Arráncalo con «npm run demo» y recarga la página.',
    '{n} cleaner asked': '{n} empresa de limpieza consultada', '{n} cleaners asked': '{n} empresas de limpieza consultadas', '{n} caterer asked': '{n} catering consultado', '{n} caterers asked': '{n} caterings consultados', '{n} plumber asked': '{n} fontanero consultado', '{n} plumbers asked': '{n} fontaneros consultados', '{n} handyman asked': '{n} manitas consultado', '{n} handymen asked': '{n} manitas consultados', '{n} pros asked': '{n} profesionales consultados',
    'Stopped: needs a change': 'Detenido: necesita un cambio', 'Saved to memory': 'Guardado en memoria', 'Checked the budget': 'Presupuesto revisado', 'Budget {amt}': 'Presupuesto {amt}', '{n} {noun} asked': '{n} {noun} consultados', 'Products · {n} skipped': 'Productos · {n} descartados', 'Products checked': 'Productos comparados', Negotiated: 'Negociado',
    'Opened {name}': 'Abierto: {name}', '{n} other options': '{n} opciones más', 'Compared {n}': '{n} comparados', 'Plan now {amt}': 'Plan de {amt}', Plan: 'Plan', 'Plan {amt}': 'Plan {amt}', ' · auto': ' · auto', '{n} payment hold': '{n} pago retenido', '{n} payment holds': '{n} pagos retenidos',
    '{m} declined · hold voided': '{m} rechaza · retención anulada', '{m} moved': '{m} cambió la fecha', Refunded: 'Reembolsado', Paid: 'Pagado', Released: 'Liberado', 'Payment updated': 'Pago actualizado',
    cleaners: 'empresas de limpieza', caterers: 'caterings', plumbers: 'fontaneros', handymen: 'manitas', pros: 'profesionales', cleaner: 'empresa de limpieza', caterer: 'catering', plumber: 'fontanero', handyman: 'manitas',
    'Alexa app': 'App de Alexa', 'Open the Alexa app (simulated)': 'Abrir la app de Alexa (simulada)', 'Start over': 'Empezar de nuevo', 'Unlink and start over': 'Desvincular y empezar de nuevo',
    'Link Mandat': 'Vincular Mandat', 'Finish in the Alexa app on your phone': 'Termina en la app de Alexa de tu teléfono', 'Sign in to Mandat': 'Iniciar sesión en Mandat', 'Choose what to share': 'Elegir qué compartes', 'Set your rules': 'Fijar tus reglas',
    'Alexa sent a notification to your phone. Mandat never sees your Amazon password.': 'Alexa envió una notificación a tu teléfono. Mandat nunca ve tu contraseña de Amazon.',
    'Linking did not finish. Nothing was shared.': 'La vinculación no terminó. No se compartió nada.',
    'To use Mandat, link your account. I sent a notification to your Alexa app.': 'Para usar Mandat, vincula tu cuenta. Te envié una notificación a la app de Alexa.',
    'Mandat is already enabled. Say “open Mandat settings” to change your rules.': 'Mandat ya está activado. Di «abre los ajustes de Mandat» para cambiar tus reglas.',
    'Mandat is unlinked. Say “Alexa, enable Mandat” to link it again.': 'Mandat está desvinculado. Di «Alexa, activa Mandat» para vincularlo de nuevo.',
    'Mandat is not enabled yet': 'Mandat aún no está activado', 'Say “Alexa, enable Mandat” to link your account and set your rules.': 'Di «Alexa, activa Mandat» para vincular tu cuenta y fijar tus reglas.', 'Try “Alexa, enable Mandat.”': 'Prueba «Alexa, activa Mandat.»', 'Not linked': 'No vinculado',
    'Alexa app on your phone (simulated)': 'App de Alexa en tu teléfono (simulada)', 'Close the Alexa app': 'Cerrar la app de Alexa',
    Settings: 'Ajustes', 'Settings saved': 'Ajustes guardados', 'Mandat paused': 'Mandat en pausa', 'Mandat resumed': 'Mandat reanudado', 'Data deleted': 'Datos borrados', 'Details shared': 'Datos compartidos', Linked: 'Vinculado', 'Say “yes, delete it” to confirm': 'Di «sí, bórralo» para confirmar',
    'Shared details updated.': 'Datos compartidos actualizados.',
  },
};
let current = 'en-US';
export const setLang = (loc) => { current = loc; };
export const lang = () => current.slice(0, 2);
export function t(s, v = {}) {
  const tpl = (lang() !== 'en' && T[lang()]?.[s]) || s;
  return tpl.replace(/\{(\w+)\}/g, (_, k) => (v[k] ?? ''));
}

// The demo script (the three stories of the video, plus looking closer and swapping), written as people say it.
export const SCRIPTS = {
  en: [
    { act: 'First run · 30 seconds', title: 'Enable Mandat', lines: ['Alexa, enable Mandat.', 'Make it 200 a week.', 'Balanced.', "That's all."] },
    { act: 'Story 1', title: 'The in-laws are coming', lines: ['Alexa, my in-laws land Saturday. Get the guest room ready: a cleaner Friday, fresh bedding, and dinner for six at home Saturday. Keep it under $400.', 'Show me the bed linen.', 'Other options?', 'Take the sateen set instead.', 'Compare the two caterers.', 'Yes, book it.'] },
    { act: 'Story 2', title: 'Four days later', lines: ["We're almost out of dog food and coffee.", 'Yes.'] },
    { act: 'Story 3', title: 'Plans change', lines: ['Their flight moved to Sunday.', 'Yes, go ahead.', 'Everything went well. Settle up: Olive billed $180, and refund the $28 pillowcases.'] },
    { act: 'Anytime', title: 'Your rules, your data', lines: ['How much is left?', 'Alexa, open Mandat settings.', 'Alexa, pause Mandat.', 'Resume Mandat.', 'My kitchen sink is leaking, find a plumber for Monday morning.', 'Delete my Mandat data.', 'Yes, delete it.'] },
  ],
  fr: [
    { act: 'Premier lancement · 30 secondes', title: 'Activer Mandat', lines: ['Alexa, active Mandat.', 'Mets 200 par semaine.', 'Équilibré.', 'C’est tout.'] },
    { act: 'Histoire 1', title: 'Les beaux-parents arrivent', lines: ['Alexa, mes beaux-parents arrivent samedi. Prépare la chambre d’amis : un ménage vendredi, du linge de lit propre, et un dîner pour six à la maison samedi. Ne dépasse pas 400 $.', 'Montre-moi le linge de lit.', 'D’autres options ?', 'Prends plutôt la parure en satin.', 'Compare les deux traiteurs.', 'Oui, réserve.'] },
    { act: 'Histoire 2', title: 'Quatre jours plus tard', lines: ['On n’a presque plus de croquettes ni de café.', 'Oui.'] },
    { act: 'Histoire 3', title: 'Changement de programme', lines: ['Leur vol a été déplacé à dimanche.', 'Oui, vas-y.', 'Tout s’est bien passé. On solde : Olive a facturé 180 $, et rembourse les 28 $ des taies d’oreiller.'] },
    { act: 'À tout moment', title: 'Vos règles, vos données', lines: ['Il reste combien ?', 'Alexa, ouvre les réglages de Mandat.', 'Alexa, mets Mandat en pause.', 'Reprends Mandat.', 'L’évier de la cuisine fuit, trouve un plombier pour lundi matin.', 'Supprime mes données Mandat.', 'Oui, supprime.'] },
  ],
  es: [
    { act: 'Primer uso · 30 segundos', title: 'Activar Mandat', lines: ['Alexa, activa Mandat.', 'Pon 200 a la semana.', 'Equilibrado.', 'Eso es todo.'] },
    { act: 'Historia 1', title: 'Llegan los suegros', lines: ['Alexa, mis suegros llegan el sábado. Prepara el cuarto de invitados: una limpieza el viernes, ropa de cama nueva y una cena para seis en casa el sábado. Que no pase de 400 dólares.', 'Enséñame la ropa de cama.', '¿Otras opciones?', 'Mejor el juego de satén.', 'Compara las dos empresas de catering.', 'Sí, resérvalo.'] },
    { act: 'Historia 2', title: 'Cuatro días después', lines: ['Casi no nos queda pienso para el perro ni café.', 'Sí.'] },
    { act: 'Historia 3', title: 'Cambio de planes', lines: ['Su vuelo se ha cambiado al domingo.', 'Sí, adelante.', 'Todo salió bien. Liquida: Olive cobró 180 dólares, y devuelve los 28 dólares de las fundas de almohada.'] },
    { act: 'En cualquier momento', title: 'Tus reglas, tus datos', lines: ['¿Cuánto queda?', 'Alexa, abre los ajustes de Mandat.', 'Alexa, pausa Mandat.', 'Reanuda Mandat.', 'El fregadero de la cocina gotea, busca un fontanero para el lunes por la mañana.', 'Borra mis datos de Mandat.', 'Sí, bórralo.'] },
  ],
};
// the first line of the budget onboarding, per language (home screen hint)
export const FIRST_LINE = { en: SCRIPTS.en[0].lines[0], fr: SCRIPTS.fr[0].lines[0], es: SCRIPTS.es[0].lines[0] };
