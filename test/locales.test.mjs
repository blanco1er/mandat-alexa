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
    coffee: 'Retiens qu’on boit du Northbeam torréfaction moyenne.',
    big: 'Alexa, mes beaux-parents arrivent samedi. Prépare la chambre d’amis : un ménage vendredi, du linge de lit propre, et un dîner pour six à la maison samedi. Ne dépasse pas 400 $.',
    look: 'Montre-moi le linge de lit.', others: 'D’autres options ?', swap: 'Prends plutôt la parure en satin.', compare: 'Compare les deux traiteurs.',
    yes: 'Oui, réserve.', restock: 'On n’a presque plus de croquettes ni de café.', yes2: 'Oui.',
    move: 'Leur vol a été déplacé à dimanche.', yes3: 'Oui, vas-y.',
    settle: 'Tout s’est bien passé. On solde : Olive a facturé 180 $, et rembourse les 28 $ des taies d’oreiller.',
    left: 'Il reste combien ?',
    expect: { plan: /J’ai demandé à 3 entreprises de ménage et 3 traiteurs\. Voici le plan : .*Total 372 \$, après 25 \$ négociés\. Il restera 28 \$ sur vos 400 \$\. Je réserve \?/, swap: /J’ai remplacé Parure d’invités par Parure en satin de coton 180, blanche\. Nouveau total 384 \$, il restera 16 \$ sur vos 400 \$\. Je réserve \?/, booked: /C’est réservé\. 3 paiements réservés pour 384 \$/, restock: /J’ai commandé Croquettes saumon et patate douce, 11 kg, 34 \$, .*écarté 2 avec du poulet car Max est allergique au poulet.*Northbeam.*52 \$.*je l’achète \?/, move: /BrightNest Cleaning accepte : samedi à 10 h.*Hearth Table Catering ne peut pas : .*Olive & Thyme Kitchen peut le faire dimanche à 19 h 30 pour 210 \$\. Je les réserve \?/, settle: /3 commandes payées\..*de moins que prévu.*remboursement de 28 \$/, left: /Visite des beaux-parents : il reste 59 \$ sur 400 \$/ },
  },
  'es-ES': {
    budget: 'Pon un presupuesto semanal de 150 dólares para la casa, y compra por tu cuenta por debajo de 40 dólares.',
    dog: 'Recuerda que Max, nuestro perro, es alérgico al pollo.',
    coffee: 'Recuerda que tomamos café Northbeam de tueste medio.',
    big: 'Alexa, mis suegros llegan el sábado. Prepara el cuarto de invitados: una limpieza el viernes, ropa de cama nueva y una cena para seis en casa el sábado. Que no pase de 400 dólares.',
    look: 'Enséñame la ropa de cama.', others: '¿Otras opciones?', swap: 'Mejor el juego de satén.', compare: 'Compara las dos empresas de catering.',
    yes: 'Sí, resérvalo.', restock: 'Casi no nos queda pienso para el perro ni café.', yes2: 'Sí.',
    move: 'Su vuelo se ha cambiado al domingo.', yes3: 'Sí, adelante.',
    settle: 'Todo salió bien. Liquida: Olive cobró 180 dólares, y devuelve los 28 dólares de las fundas de almohada.',
    left: '¿Cuánto queda?',
    expect: { plan: /Pregunté a 3 empresas de limpieza y 3 caterings\. Este es el plan: .*Total 372 \$, con 25 \$ de descuento negociado\. Te quedarán 28 \$ de tus 400 \$\. ¿Lo reservo\?/, swap: /Cambié Juego de invitados por Juego de sábanas de satén 180, blanco\. Nuevo total 384 \$, te quedarán 16 \$ de tus 400 \$\. ¿Lo reservo\?/, booked: /Reservado\. 3 pagos retenidos por 384 \$/, restock: /Pedí Pienso de salmón y boniato, 11 kg, 34 \$, .*descarté 2 con pollo porque Max es alérgico al pollo.*Northbeam.*52 \$.*¿lo compro\?/, move: /BrightNest Cleaning acepta: el sábado a las 10:00.*Hearth Table Catering no puede: .*Olive & Thyme Kitchen puede el domingo a las 19:30 por 210 \$\. ¿Lo reservo\?/, settle: /3 pedidos pagados\..*menos de lo retenido.*reembolso de 28 \$/, left: /Visita de los suegros: quedan 59 \$ de 400 \$/ },
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
