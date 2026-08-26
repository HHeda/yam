// ==========================================================================
//  Yam — l'application.
//
//  L'enchainement d'un tour est celui de `python/yam_gui/application.py`, qui
//  reste la reference : deux mains jouees systematiquement, chacune de trois
//  lancers au maximum, PUIS le choix de la main gardee, PUIS celui de la case.
//
//      PRET_MAIN1 -> MAIN1 -> PRET_MAIN2 -> MAIN2 -> CHOIX_MAIN -> CHOIX_CASE
//
//  Le drapeau `sec` de la main retenue conditionne l'acces a la colonne `sec` :
//  choisir sa main, c'est aussi choisir cet acces.
//
//  Trois ecarts assumes avec le GUI Tkinter, tous propres au telephone :
//
//  - **le mode duel n'existe pas ici.** Mesure sur 300 000 parties, il obtient
//    49,81 % de victoires, soit moins bien que la politique score-max. L'IA de
//    « contre l'IA » joue donc au score, via `jouerTour` ;
//  - **les points sont affiches en apercu** dans chaque case jouable. Le GUI ne
//    le fait pas ; sur un ecran tactile, ou l'on ne survole rien, c'est ce qui
//    remplace le fait de « voir » le plateau d'un coup d'oeil ;
//  - **le conseil peut s'appliquer d'un geste** — un bouton coche les des a
//    garder. Le texte seul est peu maniable au pouce.
// ==========================================================================

import { Moteur } from "./yam.js";

// --- Etats d'un tour, identiques a ceux du GUI ---------------------------
const PRET_MAIN1 = "pret_main1";
const MAIN1 = "main1";
const PRET_MAIN2 = "pret_main2";
const MAIN2 = "main2";
const CHOIX_MAIN = "choix_main";
const CHOIX_CASE = "choix_case";
const PARTIE_FINIE = "partie_finie";

// Les noms du moteur sont en ASCII sans accent (ils servent aussi aux journaux
// Rust). L'affichage, lui, est en francais correct.
const COLONNES = ["Descente", "Désordre", "Sec", "Montée"];
const LIGNES = ["les 1", "les 2", "les 3", "les 4", "les 5", "les 6",
                "−", "+", "Full", "Carré", "Suite", "Yam"];

// Les pastilles allumees d'une face, dans une grille 3x3 lue de gauche a droite.
const PASTILLES = {
  1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8],
};

const $ = (id) => document.getElementById(id);

let moteur = null;
let constantes = null;
/// Vrai tant que la chauffe du compilateur tourne ; le premier geste l'annule.
let chauffeEnCours = false;

// L'etat de la partie. Un seul objet : il n'y a qu'une partie a la fois.
const partie = {
  mode: "seul",
  joueurs: [],      // { nom, feuille, estIA }
  courant: 0,       // a qui de jouer
  vu: 0,            // quelle feuille est affichee
  tour: 1,
  etat: PRET_MAIN1,
  analyse: null,
  des: [],          // les 5 faces courantes
  gardes: [],       // booleens, par position
  relances: 0,
  sec: true,
  main1: null,      // { des, sec }
  main2: null,
  v1: 0,            // valeur de la main 1, pour le conseil de la main 2
};

// ==========================================================================
//  Demarrage
// ==========================================================================

async function demarrerModule() {
  try {
    moteur = await Moteur.charger("./yam_wasm.wasm", { avecReseau: true });
    constantes = moteur.constantes;
    $("etat-chargement").textContent = "moteur prêt — choisissez un mode";
    for (const b of document.querySelectorAll(".mode")) b.disabled = false;
    chauffer();
  } catch (e) {
    $("etat-chargement").textContent = `le moteur n'a pas pu démarrer : ${e.message}`;
    console.error(e);
  }
}

/// Fait tourner le solveur a vide pendant que le joueur choisit son mode.
///
/// Sans cela, la premiere decision de la partie coute ~35 ms au lieu de 5 : le
/// navigateur execute d'abord le WebAssembly avec son compilateur baseline puis
/// le recompile optimise en tache de fond (mesure : un rapport de 7, voir
/// `README.md`). L'ecran d'accueil est exactement le moment ou ce temps ne coute
/// rien.
///
/// Les salves sont bornees **en temps**, pas en nombre d'appels. C'est le fond
/// du probleme : a froid, un appel coute 34 ms, donc une salve de vingt appels
/// bloquerait le fil principal pendant presque sept dixiemes de seconde — et
/// c'est exactement ce qui est arrive, les boutons de l'accueil ne repondaient
/// plus. Une salve de 40 ms tient sous le seuil de perception, quel que soit le
/// regime du compilateur.
async function chauffer() {
  chauffeEnCours = true;
  const feuille = moteur.feuilleVide();
  const fin = performance.now() + 2500;
  while (chauffeEnCours && performance.now() < fin) {
    const finSalve = performance.now() + 40;
    do { moteur.analyser(feuille); } while (performance.now() < finSalve);
    await new Promise((r) => setTimeout(r, 0));
  }
  chauffeEnCours = false;
}

for (const bouton of document.querySelectorAll(".mode")) {
  bouton.disabled = true;
  bouton.addEventListener("click", () => {
    chauffeEnCours = false;
    nouvellePartie(bouton.dataset.mode);
  });
}

// ==========================================================================
//  La partie
// ==========================================================================

function nouvellePartie(mode) {
  partie.mode = mode;
  // `estVous` n'est pas de la decoration : le verdict de fin de partie se dit
  // « Vous l'emportez » et non « Vous l'emporte », et deviner cela sur le nom
  // serait fragile.
  const neuve = (nom, options = {}) =>
    ({ nom, feuille: moteur.feuilleVide(), estIA: false, estVous: false, ...options });
  partie.joueurs = mode === "seul"
    ? [neuve("Vous", { estVous: true })]
    : mode === "ia"
      ? [neuve("Vous", { estVous: true }), neuve("IA", { estIA: true })]
      : [neuve("Joueur 1"), neuve("Joueur 2")];
  partie.courant = 0;
  partie.vu = 0;
  partie.tour = 1;
  $("accueil").classList.add("cache");
  $("jeu").classList.remove("cache");
  fermerPanneau();
  commencerTour();
}

/// Prepare le tour du joueur courant.
///
/// C'est ici qu'a lieu l'unique operation couteuse du tour — l'analyse, ~5 ms.
/// Tout le reste (conseils, apercu des points, cases jouables) s'y adosse sans
/// recalcul.
function commencerTour() {
  const joueur = partie.joueurs[partie.courant];
  partie.vu = partie.courant;
  partie.analyse = moteur.analyser(joueur.feuille);
  partie.etat = PRET_MAIN1;
  partie.des = [];
  partie.gardes = [];
  partie.main1 = partie.main2 = null;
  partie.relances = 0;
  partie.sec = true;
  rendre();
}

function lancer() {
  if (partie.etat === PRET_MAIN1 || partie.etat === PRET_MAIN2) {
    premierLancer();
    partie.etat = partie.etat === PRET_MAIN1 ? MAIN1 : MAIN2;
  } else {
    const gardees = partie.des.filter((_, i) => partie.gardes[i]);
    partie.des = [...gardees, ...moteur.lancer(5 - gardees.length)].sort((a, b) => a - b);
    // Le drapeau `sec` ne survit que si le lancer portait sur les 5 dés.
    partie.sec = gardees.length === 0;
    partie.gardes = [false, false, false, false, false];
    partie.relances -= 1;
    if (partie.relances === 0) {
      arreterMain();
      return;
    }
  }
  rendre();
}

function premierLancer() {
  partie.des = moteur.lancer(5).sort((a, b) => a - b);
  partie.relances = constantes.NB_RELANCES;
  partie.sec = true;          // le lancer initial porte sur les 5 dés
  partie.gardes = [false, false, false, false, false];
}

function arreterMain() {
  const main = { des: [...partie.des], sec: partie.sec };
  if (partie.etat === MAIN1) {
    partie.main1 = main;
    // Le seuil exact dont a besoin le conseil de la main 2.
    partie.v1 = partie.analyse.valeurMain(main.des, main.sec);
    partie.etat = PRET_MAIN2;
    partie.des = [];
    partie.gardes = [];
  } else {
    partie.main2 = main;
    partie.etat = CHOIX_MAIN;
  }
  rendre();
}

function garderMain(numero) {
  const main = numero === 1 ? partie.main1 : partie.main2;
  partie.des = [...main.des];
  partie.sec = main.sec;
  partie.gardes = [false, false, false, false, false];
  partie.etat = CHOIX_CASE;
  rendre();
}

async function jouerCase(col, ligne) {
  if (partie.etat !== CHOIX_CASE) return;
  const joueur = partie.joueurs[partie.courant];
  if (!moteur.estJouable(joueur.feuille, col, ligne, partie.sec)) return;

  let points = moteur.points(joueur.feuille, col, ligne, partie.des);
  if (points === null) {
    // Barrer est irreversible : on demande confirmation, comme le GUI.
    const ok = await confirmer(
      "Barrer cette case ?",
      `Le contrat « ${LIGNES[ligne]} » n'est pas rempli avec ces dés.
       La case ${COLONNES[col]} / ${LIGNES[ligne]} serait barrée : 0 point, définitivement.`,
      "Barrer", "Annuler");
    if (!ok) return;
    points = 0;
  }
  joueur.feuille[col * constantes.NB_LIGNES + ligne] = points;
  await finDeTour();
}

async function finDeTour() {
  // Au tour suivant, et au joueur suivant.
  partie.courant = (partie.courant + 1) % partie.joueurs.length;
  if (partie.courant === 0) partie.tour += 1;

  if (partie.joueurs.every(feuillePleine)) {
    partie.etat = PARTIE_FINIE;
    partie.analyse = null;
    rendre();
    annoncerFin();
    return;
  }
  // Un joueur peut avoir fini avant l'autre : on saute son tour.
  while (feuillePleine(partie.joueurs[partie.courant])) {
    partie.courant = (partie.courant + 1) % partie.joueurs.length;
  }

  const suivant = partie.joueurs[partie.courant];
  if (suivant.estIA) {
    await tourIA();
    return;
  }
  if (partie.mode === "duo") {
    // On se passe le telephone : un ecran d'attente evite que le joueur
    // precedent enchaine sans s'en rendre compte.
    partie.vu = partie.courant;
    partie.etat = PRET_MAIN1;
    partie.des = [];
    rendre();
    await annoncer(`Au tour de ${suivant.nom}`,
      "<p>Passez le téléphone.</p>", "C'est parti");
  }
  commencerTour();
}

/// L'IA joue son tour entier.
///
/// Elle vise le **score**, pas la probabilite de victoire : le mode duel a ete
/// mesure a 49,81 % de victoires sur 300 000 parties, soit moins bien que
/// score-max. Voir `CLAUDE.md`.
async function tourIA() {
  const joueur = partie.joueurs[partie.courant];
  // `jouerTour` invalide l'analyse retenue par le moteur ; `commencerTour` en
  // refera une pour le joueur humain.
  const deroule = moteur.jouerTour(joueur.feuille);
  joueur.feuille = deroule.feuille;
  partie.analyse = null;
  partie.vu = partie.courant;
  rendre();

  await annoncer(`L'IA joue`, corpsTourIA(deroule), "Suite");

  partie.courant = (partie.courant + 1) % partie.joueurs.length;
  if (partie.courant === 0) partie.tour += 1;
  if (partie.joueurs.every(feuillePleine)) {
    partie.etat = PARTIE_FINIE;
    rendre();
    annoncerFin();
    return;
  }
  while (feuillePleine(partie.joueurs[partie.courant])) {
    partie.courant = (partie.courant + 1) % partie.joueurs.length;
  }
  if (partie.joueurs[partie.courant].estIA) {
    await tourIA();
    return;
  }
  commencerTour();
}

function corpsTourIA(d) {
  const main = (n) => {
    const m = d[`main${n}`];
    const suite = m.lancers.map((l) => desMini(l)).join(" → ");
    return `<p>Main ${n} : ${suite}${m.sec ? ' <span class="sec">SEC</span>' : ""}</p>`;
  };
  return main(1) + main(2) +
    `<p>Elle garde la <b>main ${d.main_retenue}</b> et joue
     <b>${COLONNES[d.colonne]} / ${LIGNES[d.ligne]}</b> :
     ${d.points} point${d.points > 1 ? "s" : ""}.</p>`;
}

function feuillePleine(joueur) {
  return !joueur.feuille.some((v) => v === constantes.VIDE);
}

function annoncerFin() {
  const scores = partie.joueurs.map((j) =>
    ({ nom: j.nom, estVous: j.estVous, score: moteur.scoreTotal(j.feuille) }));
  let corps = scores.map((s) => `<p><b>${s.nom}</b> : ${s.score} points</p>`).join("");
  if (scores.length === 2) {
    const [a, b] = scores;
    const gagnant = a.score >= b.score ? a : b;
    corps += `<p>${a.score === b.score ? "Match nul."
      : gagnant.estVous ? "<b>Vous l'emportez !</b>"
      : `<b>${gagnant.nom}</b> l'emporte.`}</p>`;
  }
  ouvrirPanneau("Partie terminée", corps, [
    { texte: "Nouvelle partie", action: () => { fermerPanneau(); nouvellePartie(partie.mode); } },
    { texte: "Changer de mode", secondaire: true, action: () => { fermerPanneau(); retourAccueil(); } },
  ]);
}

function retourAccueil() {
  $("jeu").classList.add("cache");
  $("accueil").classList.remove("cache");
}

// ==========================================================================
//  Affichage
// ==========================================================================

function rendre() {
  rendreOnglets();
  rendreGrille();
  rendreDes();
  rendreMessage();
  rendreBoutons();
}

function rendreOnglets() {
  const zone = $("onglets");
  zone.innerHTML = "";
  for (const [i, j] of partie.joueurs.entries()) {
    const b = document.createElement("button");
    b.className = "onglet" + (i === partie.courant ? " actif" : "");
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", i === partie.vu ? "true" : "false");
    b.innerHTML = `<span class="nom">${j.nom}</span>
                   <span class="points">${moteur.scoreTotal(j.feuille)}</span>`;
    b.addEventListener("click", () => { partie.vu = i; rendre(); });
    zone.appendChild(b);
  }
}

function rendreGrille() {
  const g = $("grille");
  const joueur = partie.joueurs[partie.vu];
  const sien = partie.vu === partie.courant;

  // Les cases jouables, et ce qu'elles rapporteraient. `options` donne les deux
  // en un appel, adosse a l'analyse deja faite : c'est gratuit.
  const apercu = new Map();
  if (sien && partie.etat === CHOIX_CASE && partie.analyse) {
    for (const o of partie.analyse.options(partie.des, partie.sec)) {
      apercu.set(o.colonne * constantes.NB_LIGNES + o.ligne, o);
    }
  }

  const morceaux = ['<div class="entete-ligne"></div>'];
  for (const nom of COLONNES) morceaux.push(`<div class="entete-col">${nom}</div>`);

  for (let ligne = 0; ligne < constantes.NB_LIGNES; ligne++) {
    morceaux.push(`<div class="entete-ligne">${LIGNES[ligne]}</div>`);
    for (let col = 0; col < constantes.NB_COLONNES; col++) {
      const valeur = joueur.feuille[col * constantes.NB_LIGNES + ligne];
      const o = apercu.get(col * constantes.NB_LIGNES + ligne);
      if (o) {
        morceaux.push(
          `<button class="case jouable${o.points === 0 ? " zero" : ""}"
                   data-col="${col}" data-ligne="${ligne}"
                   aria-label="${COLONNES[col]} ${LIGNES[ligne]}, ${o.points} points"
           >${o.points === 0 ? "—" : o.points}</button>`);
      } else if (valeur === constantes.VIDE) {
        morceaux.push('<div class="case vide">·</div>');
      } else if (valeur === 0) {
        morceaux.push('<div class="case barree">—</div>');
      } else {
        morceaux.push(`<div class="case">${valeur}</div>`);
      }
    }
  }

  // Les quatre lignes de totaux.
  const totaux = [];
  for (let col = 0; col < constantes.NB_COLONNES; col++) {
    totaux.push(moteur.totauxColonne(joueur.feuille, col));
  }
  morceaux.push('<div class="separateur"></div>');
  const rangee = (nom, cle, classe = "") => {
    morceaux.push(`<div class="entete-ligne">${nom}</div>`);
    for (const t of totaux) {
      const actif = cle === "bonus" && t.bonus > 0 ? " bonus-actif" : "";
      morceaux.push(`<div class="totaux valeur${classe}${actif}">${t[cle]}</div>`);
    }
  };
  rangee("partie 1", "partie1");
  rangee("bonus", "bonus");
  rangee("partie 2", "partie2");
  rangee("TOTAL", "total", " grand");

  g.innerHTML = morceaux.join("");
}

// Les cases jouables sont des boutons : une seule ecoute, posee une fois.
$("grille").addEventListener("click", (e) => {
  const case_ = e.target.closest(".case.jouable");
  if (case_) jouerCase(+case_.dataset.col, +case_.dataset.ligne);
});

function de(valeur, garde, cliquable) {
  const pastilles = Array.from({ length: 9 }, (_, i) =>
    `<span class="pastille${PASTILLES[valeur].includes(i) ? "" : " creux"}"></span>`).join("");
  const balise = cliquable ? "button" : "div";
  return `<${balise} class="de${garde ? " garde" : ""}"
            ${cliquable ? `data-de="1"` : ""}
            aria-label="dé ${valeur}${garde ? ", gardé" : ""}">${pastilles}</${balise}>`;
}

function rendreDes() {
  const zone = $("des");
  if (partie.des.length === 0) {
    zone.innerHTML = Array.from({ length: 5 },
      () => `<div class="de vide">${Array.from({ length: 9 },
        () => '<span class="pastille creux"></span>').join("")}</div>`).join("");
    return;
  }
  // On ne coche des dés que pendant une main, et seulement s'il reste un lancer.
  const cliquable = (partie.etat === MAIN1 || partie.etat === MAIN2) && partie.relances > 0;
  zone.innerHTML = partie.des
    .map((v, i) => de(v, partie.gardes[i], cliquable))
    .join("");
}

$("des").addEventListener("click", (e) => {
  const d = e.target.closest("[data-de]");
  if (!d) return;
  const i = [...$("des").children].indexOf(d);
  partie.gardes[i] = !partie.gardes[i];
  rendre();
});

function desMini(valeurs, gardes = null) {
  return '<span class="des-mini">' + valeurs
    .map((v, i) => `<b class="${gardes && gardes[i] ? "garde" : ""}">${v}</b>`)
    .join("") + "</span>";
}

function rendreMessage() {
  const m = $("message");
  const joueur = partie.joueurs[partie.courant];
  const qui = partie.joueurs.length > 1 ? `${joueur.nom} — ` : "";
  const sec = partie.sec && partie.des.length ? ' <span class="sec">SEC</span>' : "";

  if (partie.vu !== partie.courant) {
    m.innerHTML = `feuille de ${partie.joueurs[partie.vu].nom}`;
    return;
  }
  switch (partie.etat) {
    case PRET_MAIN1:
      m.innerHTML = `${qui}tour ${partie.tour} sur ${constantes.NB_CASES} — main 1`;
      break;
    case PRET_MAIN2:
      m.innerHTML = `${qui}main 1 gardée ${desMini(partie.main1.des)}
                     ${partie.main1.sec ? '<span class="sec">SEC</span>' : ""} — à la main 2`;
      break;
    case MAIN1:
    case MAIN2:
      m.innerHTML = `${qui}main ${partie.etat === MAIN1 ? 1 : 2} —
        ${partie.relances} relance${partie.relances > 1 ? "s" : ""} restante${partie.relances > 1 ? "s" : ""}${sec}`;
      break;
    case CHOIX_MAIN:
      m.innerHTML = `${qui}quelle main gardez-vous ?`;
      break;
    case CHOIX_CASE:
      m.innerHTML = `${qui}choisissez une case${sec}`;
      break;
    case PARTIE_FINIE:
      m.innerHTML = "partie terminée";
      break;
  }
}

function rendreBoutons() {
  const zone = $("boutons");
  zone.innerHTML = "";
  const ajouter = (texte, action, options = {}) => {
    const b = document.createElement("button");
    b.className = "bouton" + (options.secondaire ? " secondaire" : "");
    b.innerHTML = texte;
    b.disabled = !!options.inactif;
    if (action) b.addEventListener("click", action);
    zone.appendChild(b);
    return b;
  };

  if (partie.vu !== partie.courant) {
    ajouter("Revenir à ma feuille", () => { partie.vu = partie.courant; rendre(); }, { secondaire: true });
    return;
  }

  switch (partie.etat) {
    case PRET_MAIN1:
      ajouter("Lancer les dés", lancer);
      break;
    case PRET_MAIN2:
      ajouter("Lancer la main 2", lancer);
      break;
    case MAIN1:
    case MAIN2: {
      const gardes = partie.gardes.filter(Boolean).length;
      ajouter(
        `Relancer<span class="detail">${gardes === 0 ? "les 5 dés — reste SEC"
          : `${5 - gardes} dé${5 - gardes > 1 ? "s" : ""}`}</span>`,
        lancer,
        { inactif: gardes === 5 });
      ajouter("Garder<span class=\"detail\">arrêter cette main</span>", arreterMain, { secondaire: true });
      break;
    }
    case CHOIX_MAIN:
      for (const n of [1, 2]) {
        const m = n === 1 ? partie.main1 : partie.main2;
        ajouter(
          `Main ${n}<span class="detail">${m.des.join(" ")}${m.sec ? " · SEC" : ""}</span>`,
          () => garderMain(n),
          { secondaire: n === 2 });
      }
      break;
    case CHOIX_CASE:
      ajouter("Touchez une case verte", null, { secondaire: true, inactif: true });
      break;
    case PARTIE_FINIE:
      ajouter("Nouvelle partie", () => nouvellePartie(partie.mode));
      break;
  }
}

// ==========================================================================
//  Le conseil de l'IA — sur demande, jamais en permanence
// ==========================================================================

$("bouton-conseil").addEventListener("click", conseil);

function conseil() {
  if (!partie.analyse || partie.vu !== partie.courant) {
    ouvrirPanneau("Conseil", "<p>Lancez d'abord les dés.</p>", [boutonFermer()]);
    return;
  }
  const a = partie.analyse;
  switch (partie.etat) {
    case MAIN1:
    case MAIN2: {
      const c = partie.etat === MAIN1
        ? a.conseilMain1(partie.des, partie.relances, partie.sec)
        : a.conseilMain2(partie.des, partie.relances, partie.sec, partie.v1);
      if (c.action === "arreter") {
        ouvrirPanneau("Conseil",
          `<p>S'arrêter là.</p>
           <p class="valeur">Valeur de cette main : ${c.valeur.toFixed(1)} points.</p>`,
          [boutonFermer(), { texte: "Garder", action: () => { fermerPanneau(); arreterMain(); } }]);
      } else {
        ouvrirPanneau("Conseil",
          `<p>Garder ${desMini(c.garder)}, relancer ${desMini(c.relancer)}.</p>
           <p class="valeur">Valeur : ${c.valeur.toFixed(1)} contre
              ${c.valeur_arret.toFixed(1)} en s'arrêtant maintenant.</p>`,
          [boutonFermer(),
           { texte: "Cocher ces dés", action: () => { fermerPanneau(); appliquerGarde(c.garder); } }]);
      }
      break;
    }
    case CHOIX_MAIN: {
      const n = a.mainAGarder(partie.main1.des, partie.main1.sec, partie.main2.des, partie.main2.sec);
      const v1 = a.valeurMain(partie.main1.des, partie.main1.sec);
      const v2 = a.valeurMain(partie.main2.des, partie.main2.sec);
      ouvrirPanneau("Conseil",
        `<p>Garder la <b>main ${n}</b>.</p>
         <p class="valeur">Main 1 : ${v1.toFixed(1)} · main 2 : ${v2.toFixed(1)}.</p>`,
        [boutonFermer(), { texte: `Garder la main ${n}`, action: () => { fermerPanneau(); garderMain(n); } }]);
      break;
    }
    case CHOIX_CASE: {
      const options = a.options(partie.des, partie.sec).slice(0, 5);
      const lignes = options.map((o, i) =>
        `<tr class="${i === 0 ? "conseille" : ""}">
           <td>${COLONNES[o.colonne]} / ${LIGNES[o.ligne]}</td>
           <td>${o.barree ? "barrer" : `${o.points} pt`}</td>
           <td>${o.valeur.toFixed(1)}</td>
         </tr>`).join("");
      const meilleure = options[0];
      ouvrirPanneau("Conseil",
        `<p>Les meilleures cases avec ces dés :</p><table>${lignes}</table>
         <p class="valeur">La dernière colonne est la valeur de la feuille qui en
            résulte, bonus compris — c'est ce que l'IA maximise, pas les points.</p>`,
        [boutonFermer(),
         { texte: "Jouer celle-là", action: () => { fermerPanneau(); jouerCase(meilleure.colonne, meilleure.ligne); } }]);
      break;
    }
    default:
      // Avant le lancer, il n'y a pas de coup a conseiller — mais l'analyse est
      // deja faite, et elle sait ce que vaut la feuille. Autant le dire plutot
      // que d'ouvrir un panneau vide.
      ouvrirPanneau("Conseil",
        `<p>Lancez d'abord les dés.</p>
         <p class="valeur">À partir de cette feuille, l'IA compte marquer encore
            ${a.valeur.toFixed(0)} points d'ici la fin de la partie.</p>`,
        [boutonFermer(), { texte: "Lancer les dés", action: () => { fermerPanneau(); lancer(); } }]);
  }
}

/// Coche les des correspondant aux faces conseillees.
///
/// Le conseil rend des **faces** (`[6, 6]`), pas des positions : il faut donc
/// les apparier, en veillant a ne pas cocher deux fois le meme de.
function appliquerGarde(faces) {
  partie.gardes = [false, false, false, false, false];
  for (const face of faces) {
    const i = partie.des.findIndex((v, k) => v === face && !partie.gardes[k]);
    if (i >= 0) partie.gardes[i] = true;
  }
  rendre();
}

// ==========================================================================
//  Le panneau : conseils, confirmations, annonces
// ==========================================================================

let fermeturePanneau = null;

function boutonFermer(texte = "Fermer") {
  return { texte, secondaire: true, action: () => fermerPanneau() };
}

function ouvrirPanneau(titre, corps, boutons) {
  $("panneau-titre").textContent = titre;
  $("panneau-corps").innerHTML = corps;
  const zone = $("panneau-boutons");
  zone.innerHTML = "";
  for (const b of boutons) {
    const el = document.createElement("button");
    el.className = "bouton" + (b.secondaire ? " secondaire" : "");
    el.textContent = b.texte;
    el.addEventListener("click", b.action);
    zone.appendChild(el);
  }
  $("voile").classList.remove("cache");
  $("panneau").classList.remove("cache");
}

function fermerPanneau(resultat) {
  $("voile").classList.add("cache");
  $("panneau").classList.add("cache");
  const suite = fermeturePanneau;
  fermeturePanneau = null;
  if (suite) suite(resultat);
}

/// Une confirmation, en promesse. Barrer une case est irreversible : c'est le
/// seul geste du jeu qui en demande une.
function confirmer(titre, texte, oui, non) {
  return new Promise((resoudre) => {
    fermeturePanneau = (r) => resoudre(r === true);
    ouvrirPanneau(titre, `<p>${texte}</p>`, [
      { texte: non, secondaire: true, action: () => fermerPanneau(false) },
      { texte: oui, action: () => fermerPanneau(true) },
    ]);
  });
}

/// Une annonce a acquitter, en promesse.
function annoncer(titre, corps, bouton) {
  return new Promise((resoudre) => {
    fermeturePanneau = () => resoudre();
    ouvrirPanneau(titre, corps, [{ texte: bouton, action: () => fermerPanneau() }]);
  });
}

// Le voile ne ferme que les panneaux purement informatifs : une confirmation
// doit etre tranchee par un bouton, pas par un doigt qui glisse a cote.
$("voile").addEventListener("click", () => {
  if (!fermeturePanneau) fermerPanneau();
});

// ==========================================================================
//  Menu
// ==========================================================================

$("bouton-menu").addEventListener("click", () => {
  ouvrirPanneau("Menu",
    `<p class="valeur">Mode « ${{ seul: "seul", ia: "contre l'IA", duo: "à deux" }[partie.mode]} »,
     tour ${partie.tour} sur ${constantes.NB_CASES}.</p>`,
    [
      boutonFermer("Reprendre"),
      { texte: "Nouvelle partie", action: () => { fermerPanneau(); nouvellePartie(partie.mode); } },
      { texte: "Changer de mode", secondaire: true, action: () => { fermerPanneau(); retourAccueil(); } },
    ]);
});

// ==========================================================================
//  Hors ligne
// ==========================================================================

// Le service worker exige un contexte securise : HTTPS, ou localhost. Sur une
// adresse de reseau local en clair il ne s'enregistrera pas, et c'est sans
// consequence — le jeu marche, il n'est simplement pas disponible hors ligne.
//
// **Il ne s'enregistre pas non plus sur localhost par defaut.** Son cache est
// « tout, tout de suite », ce qui est exactement ce qu'on veut une fois
// installe et exactement ce qu'on ne veut pas en developpement : il resservait
// l'ancien CSS et l'ancien JavaScript apres chaque modification, sans rien
// signaler. Le piege a coute une mise au point entiere. Pour eprouver le
// hors-ligne malgre tout, ouvrir `http://localhost:8765/?sw`.
const enDeveloppement = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
if ("serviceWorker" in navigator) {
  if (!enDeveloppement || new URLSearchParams(location.search).has("sw")) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  } else {
    // On defait ce qu'une visite precedente aurait pu installer.
    navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister()));
    if (window.caches) caches.keys().then((noms) => noms.forEach((n) => caches.delete(n)));
  }
}

demarrerModule();
