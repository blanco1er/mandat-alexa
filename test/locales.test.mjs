// French and Spanish: the three stories and the look-closer / swap flow, spoken and answered in the user's language,
// with the same money rules (the explicit yes is checked per language, never looser than English).
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, sc, talker } from './helpers.mjs';
import { isExplicitYes } from '../src/mandat.mjs';
import { money, slot, spokenSlot, canon } from '../src/core/i18n.mjs';

const srv = await boot();
test.after(() => srv.close());
const names = (o) => o.steps.map((s) => s.name);
const last = (o, n) => [...o.steps].reverse().find((s) => s.name === n)?.result;

test('explicit yes per language: oui / sí / ja-like words count, a no or a wait never does', () => {
  for (const y of ['yes', 'Yes, book it.', 'Oui, réserve.', 'oui', 'D’accord, vas-y', 'Sí, resérvalo.', 'si', 'Vale, adelante', '¡Sí!', 'tap:approve']) assert.ok(isExplicitYes(y), y);
  for (const n of ['no', 'Oui mais attends', 'Non', 'Sí, pero espera', 'No, cancela', 'peut-être', 'quizás', 'show me more', 'montre-moi', 'yesterday', 'sinon', 'siempre', '', null]) assert.ok(!isExplicitYes(n), String(n));
});

test('formats follow the locale; the household currency stays USD', () => {
  assert.equal(money(372, 'en-US'), '$372');
  assert.equal(money(372, 'fr-FR'), '372 $');
  assert.equal(money(372, 'es-ES'), '372 $');
  assert.equal(money(19.5, 'fr-FR'), '19,50 $');
  assert.equal(slot('Saturday 7:30 PM', 'fr-FR'), 'samedi 19 h 30');
  assert.equal(slot('Friday 10 AM', 'es-ES'), 'viernes 10:00');
  assert.equal(spokenSlot('Sunday 7:30 PM', 'fr-FR'), 'dimanche à 19 h 30');
  assert.equal(spokenSlot('Sunday 7:30 PM', 'es-ES'), 'el domingo a las 19:30');
  assert.equal(slot('Delivery in 2 days', 'fr-FR'), 'Livraison sous 2 jours');
  assert.match(canon('Ne dépasse pas 400 $.', 'fr-FR'), /keep it under \$400/);
  assert.match(canon('Que no pase de 400 dólares.', 'es-ES'), /keep it under \$400/);
});

const STORIES = {
  'fr-FR': {
    budget: 'Fixe un budget hebdomadaire de 150 $ pour la maison, et achète toute seule en dessous de 40 $.',
    dog: 'Souviens-toi que Max, notre chien, est allergique au poulet.',
    coffee: 'Retiens qu’on utilise la lessive Seventh Generation.',
    big: 'Alexa, mes beaux-parents arrivent samedi. Prépare la chambre d’amis : un ménage vendredi, du linge de lit propre, et un dîner pour six à la maison samedi. Ne dépasse pas 400 $.',
    look: 'Montre-moi le linge de lit.', others: 'D’autres options ?', swap: 'Prends plutôt la première.', compare: 'Compare les deux traiteurs.',
    yes: 'Oui, réserve.', restock: 'On n’a presque plus de croquettes ni de lessive.', yes2: 'Oui.',
    move: 'Leur vol a été déplacé à dimanche.', yes3: 'Oui, vas-y.',
    settle: 'Tout s’est bien passé. On solde : Olive a facturé 180 $, et rembourse les 10 $ des draps.',
    left: 'Il reste combien ?',
    expect: { plan: /J’ai trouvé 4 entreprises de ménage près de Capitol Hill et 4 traiteurs plus 3 partenaires de démo\. Voici le plan : Pure House Cleaning, environ 100 \$ estimés, .*Hearth Table Catering, partenaire de démo, 195 \$\. Total 380 \$, après 15 \$ négociés\. Il restera 20 \$ sur vos 400 \$\. Tout est payé .*demande de réservation à prix estimé.*Je réserve \?/, swap: /J’ai remplacé Parure d’invités par Parure en microfibre 160, grise\. Nouveau total 344 \$, il restera 56 \$ sur vos 400 \$\. Je réserve \?/, booked: /C’est fait\. 3 paiements réservés pour 344 \$.*Pure House Cleaning a une demande de réservation à prix estimé, non confirmée\./, restock: /C’est fait, sous votre règle d’achat automatique : Croquettes saumon et patate douce, 11 kg, 34 \$, .*écarté 2 avec du poulet car Max est allergique au poulet.*Seventh Generation.*52 \$.*je l’achète \?/, move: /J’ai déplacé la demande de réservation de Pure House Cleaning à samedi à 10 h.*ne l’a pas confirmée\. Hearth Table Catering ne peut pas : .*Olive & Thyme Kitchen peut le faire dimanche à 19 h 30 pour 210 \$\. Je les réserve \?/, settle: /3 commandes réglées\..*de moins que prévu.*Remboursé 10 \$/, left: /Visite des beaux-parents : il reste 81 \$ sur 400 \$/ },
  },
  'es-ES': {
    budget: 'Pon un presupuesto semanal de 150 dólares para la casa, y compra por tu cuenta por debajo de 40 dólares.',
    dog: 'Recuerda que Max, nuestro perro, es alérgico al pollo.',
    coffee: 'Recuerda que usamos el detergente Seventh Generation.',
    big: 'Alexa, mis suegros llegan el sábado. Prepara el cuarto de invitados: una limpieza el viernes, ropa de cama nueva y una cena para seis en casa el sábado. Que no pase de 400 dólares.',
    look: 'Enséñame la ropa de cama.', others: '¿Otras opciones?', swap: 'Mejor la primera.', compare: 'Compara las dos empresas de catering.',
    yes: 'Sí, resérvalo.', restock: 'Casi no nos queda pienso para el perro ni detergente.', yes2: 'Sí.',
    move: 'Su vuelo se ha cambiado al domingo.', yes3: 'Sí, adelante.',
    settle: 'Todo salió bien. Liquida: Olive cobró 180 dólares, y devuelve los 10 dólares de las sábanas.',
    left: '¿Cuánto queda?',
    expect: { plan: /Encontré 4 empresas de limpieza cerca de Capitol Hill y 4 caterings más 3 socios de demostración\. Este es el plan: Pure House Cleaning, unos 100 \$ estimados, .*Hearth Table Catering, socio de demostración, 195 \$\. Total 380 \$, con 15 \$ de descuento negociado\. Te quedarán 20 \$ de tus 400 \$\. Todo se paga .*solicitud de reserva a precio estimado.*¿Lo reservo\?/, swap: /Cambié Juego de invitados por Juego de sábanas de microfibra 150, gris\. Nuevo total 344 \$, te quedarán 56 \$ de tus 400 \$\. ¿Lo reservo\?/, booked: /Hecho\. 3 pagos retenidos por 344 \$.*Pure House Cleaning tiene una solicitud de reserva a precio estimado, sin confirmar\./, restock: /Hecho, dentro de tu regla de compra automática: Pienso de salmón y boniato, 11 kg, 34 \$, .*descarté 2 con pollo porque Max es alérgico al pollo.*Seventh Generation.*52 \$.*¿lo compro\?/, move: /Cambié la solicitud de reserva de Pure House Cleaning al sábado a las 10:00.*no la ha confirmado\. Hearth Table Catering no puede: .*Olive & Thyme Kitchen puede el domingo a las 19:30 por 210 \$\. ¿Lo reservo\?/, settle: /3 pedidos liquidados\..*menos de lo retenido.*Reembolsé 10 \$/, left: /Visita de los suegros: quedan 81 \$ de 400 \$/ },
  },
};

for (const [locale, L] of Object.entries(STORIES)) {
  test(`${locale}: the three stories and the look-closer / swap flow, every answer in ${locale}`, async () => {
    const say = talker(srv.mcpUrl, `loc-${locale}-${Math.random().toString(36).slice(2, 6)}`, 'show', locale);
    const b = await say(L.budget);
    assert.deepEqual(names(b), ['set_spending_mandate']);
    assert.equal(sc(last(b, 'set_spending_mandate')).mandate.auto_approve_under, 40);
    const d = await say(L.dog);
    assert.deepEqual(names(d), ['remember_preference']);
    await say(L.coffee);
    const plan = await say(L.big);
    assert.deepEqual(names(plan), ['set_spending_mandate', 'find_home_services', 'find_products', 'find_home_services', 'propose_plan'], plan.speech);
    assert.match(plan.speech, L.expect.plan);
    assert.deepEqual(names(await say(L.look)), ['get_offer_details']);
    assert.deepEqual(names(await say(L.others)), ['list_alternatives']);
    const swap = await say(L.swap);
    assert.deepEqual(names(swap), ['revise_plan'], swap.speech);
    assert.match(swap.speech, L.expect.swap);
    const cmp = await say(L.compare);
    assert.deepEqual(names(cmp), ['compare_offers'], cmp.speech);
    const yes = await say(L.yes);
    assert.deepEqual(names(yes), ['confirm_plan'], yes.speech);
    assert.match(yes.speech, L.expect.booked);
    const restock = await say(L.restock);
    assert.deepEqual(names(restock), ['find_products', 'propose_plan', 'confirm_plan', 'find_products', 'propose_plan'], restock.speech);
    assert.match(restock.speech, L.expect.restock);
    assert.deepEqual(names(await say(L.yes2)), ['confirm_plan']);
    const move = await say(L.move);
    assert.deepEqual(names(move), ['get_household_status', 'change_order', 'change_order', 'propose_plan'], move.speech);
    assert.match(move.speech, L.expect.move);
    await say(L.yes3);
    const settle = await say(L.settle);
    assert.match(settle.speech, L.expect.settle);
    const left = await say(L.left);
    assert.match(left.speech, L.expect.left);
  });
}
