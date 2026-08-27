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
//
// Les colonnes portent le meme nom partout. Les **lignes**, elles, ont deux
// formes : la carte ecrit « 3 », faute de place, la ou une phrase dit « les 3 ».
// Le carton familial fait exactement la meme distinction.
const COLONNES = ["Descente", "Désordre", "Sec", "Montée"];
const LIGNES = ["les 1", "les 2", "les 3", "les 4", "les 5", "les 6",
                "−", "+", "Full", "Carré", "Suite", "Yam"];
const LIGNES_CARTE = ["1", "2", "3", "4", "5", "6",
                      "−", "+", "Full", "Carré", "Suite", "Yams"];

// Les pastilles allumees d'une face, dans une grille 3x3 lue de gauche a droite.
const PASTILLES = {
  1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8],
};

const $ = (id) => document.getElementById(id);

/// Echappe un texte destine a `innerHTML`.
///
/// Les noms de joueurs sont **saisis** : ils finissent dans les onglets, les
/// messages et le panneau de fin, tous construits par concatenation de HTML. Un
/// nom contenant `<` casserait la mise en page, et le reste suivrait.
function echapper(texte) {
  return String(texte).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

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
  // Booleens par position : vrai = ce de sera relance. C'est le geste reel —
  // on ramasse les des qu'on rejette, pas ceux qu'on garde.
  relance: [],
  relances: 0,
  sec: true,
  main1: null,      // { des, sec }
  main2: null,
  v1: 0,            // valeur de la main 1, pour le conseil de la main 2
  // Vrai des que le joueur a consulte l'IA une fois dans la partie. C'est une
  // information de fin de partie : un score obtenu en suivant les conseils ne
  // se compare pas a un score obtenu seul.
  aideUtilisee: false,
  // Vrai entre le coup de l'IA et son acquittement par le joueur. C'est
  // l'invariant sur lequel s'appuie la reprise : on ne sauvegarde un etat « au
  // tour de l'IA » qu'apres qu'elle a joue.
  iaAJoue: false,
};

// ==========================================================================
//  Demarrage
// ==========================================================================

async function demarrerModule() {
  try {
    moteur = await Moteur.charger("./yam_wasm.wasm", { avecReseau: true });
    constantes = moteur.constantes;
    $("etat-chargement").textContent = "";
    for (const b of document.querySelectorAll(".mode")) b.disabled = false;
    rafraichirAccueil();
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

for (const bouton of document.querySelectorAll(".mode[data-mode]")) {
  bouton.disabled = true;
  bouton.addEventListener("click", async () => {
    chauffeEnCours = false;
    // Commencer une partie efface celle qui attendait : on ne le fait pas dans
    // le dos du joueur.
    if (partieEnMemoire() && !await confirmer("Abandonner la partie en cours ?",
        "Une partie attend en mémoire. En commencer une nouvelle l'effacera définitivement.",
        "Nouvelle partie", "Annuler")) {
      return;
    }
    const mode = bouton.dataset.mode;
    if (mode === "duo") {
      const noms = await demanderNoms();
      if (!noms) return;
      nouvellePartie(mode, noms);
      return;
    }
    nouvellePartie(mode);
  });
}

$("bouton-reprendre").disabled = true;
$("bouton-reprendre").addEventListener("click", () => {
  chauffeEnCours = false;
  if (!reprendrePartie()) rafraichirAccueil();   // la sauvegarde a disparu
});

$("bouton-historique").addEventListener("click", montrerHistorique);

// ==========================================================================
//  La partie
// ==========================================================================

const CLE_NOMS = "yam.noms.v1";
const NOMS_PAR_DEFAUT = ["Joueur 1", "Joueur 2"];

/// Demande les deux noms. Rend `null` si le joueur renonce.
///
/// Les noms de la derniere partie sont proposes : on joue rarement a deux une
/// seule fois, et retaper deux noms a chaque partie serait une corvee.
function demanderNoms() {
  const anciens = lireMemoire(CLE_NOMS);
  const proposes = Array.isArray(anciens) && anciens.length === 2 ? anciens : NOMS_PAR_DEFAUT;
  return new Promise((resoudre) => {
    fermeturePanneau = (r) => resoudre(r || null);
    ouvrirPanneau("Qui joue ?",
      `<p class="valeur">Chacun son tour, sur ce téléphone.</p>
       <div class="champs">
         <label>Premier joueur
           <input id="nom-1" type="text" maxlength="14" autocomplete="off"
                  enterkeyhint="next" value="${echapper(proposes[0])}"></label>
         <label>Second joueur
           <input id="nom-2" type="text" maxlength="14" autocomplete="off"
                  enterkeyhint="done" value="${echapper(proposes[1])}"></label>
       </div>`,
      [
        { texte: "Annuler", secondaire: true, action: () => fermerPanneau(null) },
        { texte: "Commencer", action: () => {
            // Un champ vide reprend son nom par defaut : mieux vaut un joueur
            // nomme « Joueur 2 » qu'un onglet vide.
            const noms = [1, 2].map((n, i) =>
              ($(`nom-${n}`).value.trim() || NOMS_PAR_DEFAUT[i]).slice(0, 14));
            ecrireMemoire(CLE_NOMS, noms);
            fermerPanneau(noms);
          } },
      ]);
    $("nom-1").select();
  });
}

function nouvellePartie(mode, noms = NOMS_PAR_DEFAUT) {
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
      : [neuve(noms[0]), neuve(noms[1])];
  partie.courant = 0;
  partie.vu = 0;
  partie.tour = 1;
  partie.iaAJoue = false;
  partie.aideUtilisee = false;
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
  partie.relance = [];
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
    const gardees = partie.des.filter((_, i) => !partie.relance[i]);
    partie.des = [...gardees, ...moteur.lancer(5 - gardees.length)].sort((a, b) => a - b);
    // Le drapeau `sec` ne survit que si le lancer portait sur les 5 dés — et il
    // renait a chaque lancer complet, meme si la main l'avait perdu.
    partie.sec = gardees.length === 0;
    partie.relance = [false, false, false, false, false];
    partie.relances -= 1;
    if (partie.relances === 0) {
      arreterMain();
      return;
    }
  }
  rendre();
}

/// Relance les cinq des, sans avoir a les cocher un par un.
///
/// C'est le geste le plus frequent d'un debut de main, et le seul qui redonne
/// le drapeau `sec` : le passer par cinq touchers serait absurde.
function toutRelancer() {
  partie.relance = [true, true, true, true, true];
  lancer();
}

function premierLancer() {
  partie.des = moteur.lancer(5).sort((a, b) => a - b);
  partie.relances = constantes.NB_RELANCES;
  partie.sec = true;          // le lancer initial porte sur les 5 dés
  partie.relance = [false, false, false, false, false];
}

function arreterMain() {
  const main = { des: [...partie.des], sec: partie.sec };
  if (partie.etat === MAIN1) {
    partie.main1 = main;
    // Le seuil exact dont a besoin le conseil de la main 2.
    partie.v1 = partie.analyse.valeurMain(main.des, main.sec);
    partie.etat = PRET_MAIN2;
    partie.des = [];
    partie.relance = [];
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
  partie.relance = [false, false, false, false, false];
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
  partie.iaAJoue = true;    // la sauvegarde qui suit est donc reprenable
  rendre();

  await annoncer(`L'IA joue`, corpsTourIA(deroule), "Suite");
  await avancerApresIA();
}

/// Passe au joueur suivant, l'IA ayant joue.
///
/// Extrait de `tourIA` parce que la **reprise** en a besoin : une partie
/// sauvegardee au tour de l'IA l'a forcement ete apres son coup, et il ne reste
/// alors qu'a faire ceci.
async function avancerApresIA() {
  partie.iaAJoue = false;
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
  inscrireAuxArchives(scores);
  oublierMemoire(CLE_PARTIE);
  let corps = scores.map((s) => `<p><b>${echapper(s.nom)}</b> : ${s.score} points</p>`).join("");
  if (scores.length === 2) {
    const [a, b] = scores;
    const gagnant = a.score >= b.score ? a : b;
    corps += `<p>${a.score === b.score ? "Match nul."
      : gagnant.estVous ? "<b>Vous l'emportez !</b>"
      : `<b>${echapper(gagnant.nom)}</b> l'emporte.`}</p>`;
  }
  ouvrirPanneau("Partie terminée", corps, [
    { texte: "Nouvelle partie", action: () => { fermerPanneau(); rejouer(); } },
    { texte: "Changer de mode", secondaire: true, action: () => { fermerPanneau(); retourAccueil(); } },
  ]);
}

/// Relance une partie dans le meme mode, en gardant les memes joueurs.
function rejouer() {
  nouvellePartie(partie.mode, partie.joueurs.map((j) => j.nom));
}

function retourAccueil() {
  $("jeu").classList.add("cache");
  $("accueil").classList.remove("cache");
  rafraichirAccueil();
  // C'est le seul moment sur pour recharger : aucune partie n'est en cours.
  proposerMiseAJour();
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
  // Un seul point de sauvegarde, appele a chaque changement d'etat : c'est ce
  // qui garantit qu'on ne peut pas oublier d'enregistrer quelque part.
  sauverPartie();
}

function rendreOnglets() {
  const zone = $("onglets");
  zone.innerHTML = "";
  for (const [i, j] of partie.joueurs.entries()) {
    const b = document.createElement("button");
    b.className = "onglet" + (i === partie.courant ? " actif" : "");
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", i === partie.vu ? "true" : "false");
    b.innerHTML = `<span class="nom">${echapper(j.nom)}</span>
                   <span class="points">${moteur.scoreTotal(j.feuille)}</span>`;
    b.addEventListener("click", () => { partie.vu = i; rendre(); });
    zone.appendChild(b);
  }
}

/// Les rangees de la carte, dans l'ordre du carton familial.
///
/// L'ordre n'est pas celui du moteur, et c'est tout l'interet : le sous-total,
/// le bonus et le total de la premiere partie sont **intercales** juste apres
/// les six chiffres, la ou on les calcule vraiment. Les mettre en bas, comme le
/// faisait la premiere version, obligeait a chercher son bonus a l'autre bout
/// de la feuille.
function rangeesCarte() {
  const r = [];
  for (let l = 0; l < 6; l++) r.push({ jeu: l, nom: LIGNES_CARTE[l] });
  r.push({ compte: "partie1", nom: "S/total" });
  r.push({ compte: "bonus", nom: "Bonus" });
  r.push({ compte: "total1", nom: "Total", somme: true });
  for (let l = 6; l < constantes.NB_LIGNES; l++) r.push({ jeu: l, nom: LIGNES_CARTE[l], somme: true });
  r.push({ general: true, nom: "Total" });
  return r;
}

function rendreGrille() {
  const g = $("grille");
  const joueur = partie.joueurs[partie.vu];
  const sien = partie.vu === partie.courant;
  const NL = constantes.NB_LIGNES;
  const NC = constantes.NB_COLONNES;

  // Les cases jouables, et ce qu'elles rapporteraient. `options` donne les deux
  // en un appel, adosse a l'analyse deja faite : c'est gratuit.
  const apercu = new Map();
  if (sien && partie.etat === CHOIX_CASE && partie.analyse) {
    for (const o of partie.analyse.options(partie.des, partie.sec)) {
      apercu.set(o.colonne * NL + o.ligne, o);
    }
  }

  const totaux = [];
  for (let col = 0; col < NC; col++) {
    const t = moteur.totauxColonne(joueur.feuille, col);
    t.total1 = t.partie1 + t.bonus;      // ce que le carton appelle « Total »
    totaux.push(t);
  }

  const morceaux = ['<div class="entete-ligne"></div>'];
  for (const nom of COLONNES) morceaux.push(`<div class="entete-col">${nom}</div>`);
  // La cinquieme colonne du carton n'a pas d'en-tete : c'est le total de la
  // ligne, et il ne commence qu'a la rangee « Total ».
  morceaux.push('<div class="entete-col"></div>');

  for (const rangee of rangeesCarte()) {
    morceaux.push(`<div class="entete-ligne">${rangee.nom}</div>`);
    let sommeLigne = 0;
    let quelqueChose = false;

    if (rangee.jeu !== undefined) {
      const ligne = rangee.jeu;
      for (let col = 0; col < NC; col++) {
        const valeur = joueur.feuille[col * NL + ligne];
        const o = apercu.get(col * NL + ligne);
        if (valeur !== constantes.VIDE) {
          sommeLigne += valeur;
          quelqueChose = true;
        }
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
    } else if (rangee.compte) {
      // Ces trois comptes ne dependent que des six chiffres du haut. Tant qu'une
      // colonne n'en a aucun, sa case reste **vide** : un carton vierge ne porte
      // pas une rangee de zeros, et afficher « 0 » n'apprendrait rien. Une case
      // barree, elle, compte bien — elle vaut zero pour de bon, et le zero
      // s'affiche alors.
      for (let col = 0; col < NC; col++) {
        const t = totaux[col];
        const commence = [...Array(6).keys()]
          .some((l) => joueur.feuille[col * NL + l] !== constantes.VIDE);
        const actif = rangee.compte === "bonus" && t.bonus > 0 ? " bonus-actif" : "";
        morceaux.push(`<div class="totaux valeur${actif}">${commence ? t[rangee.compte] : ""}</div>`);
        if (commence) {
          sommeLigne += t[rangee.compte];
          quelqueChose = true;
        }
      }
    } else {
      // La derniere rangee ne porte que le total general, en bas a droite.
      for (let col = 0; col < NC; col++) morceaux.push('<div class="totaux inerte"></div>');
      morceaux.push(`<div class="totaux somme grand">${moteur.scoreTotal(joueur.feuille)}</div>`);
      continue;
    }

    // Le total de la ligne, dans la cinquieme colonne.
    morceaux.push(rangee.somme && quelqueChose
      ? `<div class="totaux somme">${sommeLigne}</div>`
      : '<div class="totaux somme"></div>');
  }

  g.innerHTML = morceaux.join("");
}

// Les cases jouables sont des boutons : une seule ecoute, posee une fois.
$("grille").addEventListener("click", (e) => {
  const case_ = e.target.closest(".case.jouable");
  if (case_) jouerCase(+case_.dataset.col, +case_.dataset.ligne);
});

function de(valeur, marque, cliquable) {
  const pastilles = Array.from({ length: 9 }, (_, i) =>
    `<span class="pastille${PASTILLES[valeur].includes(i) ? "" : " creux"}"></span>`).join("");
  const balise = cliquable ? "button" : "div";
  return `<${balise} class="de${marque ? " marque" : ""}"
            ${cliquable ? `data-de="1"` : ""}
            aria-pressed="${marque}"
            aria-label="dé ${valeur}${marque ? ", à relancer" : ""}">${pastilles}</${balise}>`;
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
    .map((v, i) => de(v, partie.relance[i], cliquable))
    .join("");
}

$("des").addEventListener("click", (e) => {
  const d = e.target.closest("[data-de]");
  if (!d) return;
  const i = [...$("des").children].indexOf(d);
  partie.relance[i] = !partie.relance[i];
  rendre();
});

function desMini(valeurs, marques = null) {
  return '<span class="des-mini">' + valeurs
    .map((v, i) => `<b class="${marques && marques[i] ? "marque" : ""}">${v}</b>`)
    .join("") + "</span>";
}

function rendreMessage() {
  const m = $("message");
  const joueur = partie.joueurs[partie.courant];
  const qui = partie.joueurs.length > 1 ? `${echapper(joueur.nom)} — ` : "";
  const sec = partie.sec && partie.des.length ? ' <span class="sec">SEC</span>' : "";

  if (partie.vu !== partie.courant) {
    m.innerHTML = `feuille de ${echapper(partie.joueurs[partie.vu].nom)}`;
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
  // Les commandes tiennent sur une ou deux rangees. A trois boutons cote a
  // cote, la cible tactile tombe sous les 44 px recommandes ; on empile.
  let rangee = null;
  const nouvelleRangee = () => {
    rangee = document.createElement("div");
    rangee.className = "rangee";
    zone.appendChild(rangee);
  };
  const ajouter = (texte, action, options = {}) => {
    if (!rangee) nouvelleRangee();
    const b = document.createElement("button");
    b.className = "bouton" + (options.secondaire ? " secondaire" : "");
    b.innerHTML = texte;
    b.disabled = !!options.inactif;
    if (action) b.addEventListener("click", action);
    rangee.appendChild(b);
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
      const n = partie.relance.filter(Boolean).length;
      ajouter(
        `Relancer<span class="detail">${n === 0 ? "aucun dé choisi"
          : `${n} dé${n > 1 ? "s" : ""}`}</span>`,
        lancer,
        { inactif: n === 0 });
      // Relancer les cinq redonne toujours le drapeau `sec`, meme si la main
      // l'avait perdu : c'est une information qui pese sur la decision.
      ajouter('Tout relancer<span class="detail">les 5 dés · SEC</span>',
        toutRelancer, { secondaire: true });
      nouvelleRangee();
      ajouter('Garder<span class="detail">arrêter cette main</span>',
        arreterMain, { secondaire: true });
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
      ajouter("Nouvelle partie", rejouer);
      break;
  }
}

// ==========================================================================
//  Le conseil de l'IA — sur demande, jamais en permanence
// ==========================================================================

$("bouton-conseil").addEventListener("click", conseil);

/// Le score **final** que l'IA estime, a partir d'une de ses valeurs.
///
/// Le moteur ne rend jamais un score final : il rend le **reste**, ce qu'il
/// compte encore marquer d'ici la fin de la partie. C'est ce dont il a besoin,
/// mais ce n'est pas ce qu'un joueur veut lire — « 847 » ne dit rien quand on
/// en est a 500. On y rajoute donc ce qui est deja sur la feuille.
///
/// Les deux termes vont bien ensemble : le score acquis contient les bonus deja
/// obtenus, et l'estimation du reste contient ceux qui restent a prendre.
function scoreEstime(valeur) {
  const feuille = partie.joueurs[partie.courant].feuille;
  return Math.round(moteur.scoreTotal(feuille) + valeur);
}

function conseil() {
  if (!partie.analyse || partie.vu !== partie.courant) {
    ouvrirPanneau("Conseil", "<p>Lancez d'abord les dés.</p>", [boutonFermer()]);
    return;
  }
  const a = partie.analyse;
  // Le panneau va donner un avis : la partie ne sera plus « sans aide ». Le cas
  // ecarte ci-dessus (pas d'analyse) ne compte pas, il n'apprend rien.
  partie.aideUtilisee = true;
  switch (partie.etat) {
    case MAIN1:
    case MAIN2: {
      const c = partie.etat === MAIN1
        ? a.conseilMain1(partie.des, partie.relances, partie.sec)
        : a.conseilMain2(partie.des, partie.relances, partie.sec, partie.v1);
      if (c.action === "arreter") {
        ouvrirPanneau("Conseil",
          `<p>S'arrêter là.</p>
           <p class="valeur">Score estimé : <b>${scoreEstime(c.valeur)}</b>.</p>`,
          [boutonFermer(), { texte: "Garder", action: () => { fermerPanneau(); arreterMain(); } }]);
      } else if (c.garder.length === 0) {
        // Relancer les cinq des : il n'y a rien a cocher, et l'ecrire
        // « garder — , relancer 1 2 3 4 5 » ne fait que noyer le conseil.
        ouvrirPanneau("Conseil",
          `<p>Relancer tout.</p>
           <p class="valeur">Score estimé : <b>${scoreEstime(c.valeur)}</b>, contre
              ${scoreEstime(c.valeur_arret)} en s'arrêtant maintenant.</p>`,
          [boutonFermer(),
           { texte: "Relancer tout", action: () => { fermerPanneau(); toutRelancer(); } }]);
      } else {
        ouvrirPanneau("Conseil",
          `<p>Garder ${desMini(c.garder)}, relancer ${desMini(c.relancer)}.</p>
           <p class="valeur">Score estimé : <b>${scoreEstime(c.valeur)}</b>, contre
              ${scoreEstime(c.valeur_arret)} en s'arrêtant maintenant.</p>`,
          [boutonFermer(),
           { texte: "Relancer ces dés", action: () => { fermerPanneau(); relancerConseilles(c.relancer); } }]);
      }
      break;
    }
    case CHOIX_MAIN: {
      const n = a.mainAGarder(partie.main1.des, partie.main1.sec, partie.main2.des, partie.main2.sec);
      const v1 = a.valeurMain(partie.main1.des, partie.main1.sec);
      const v2 = a.valeurMain(partie.main2.des, partie.main2.sec);
      ouvrirPanneau("Conseil",
        `<p>Garder la <b>main ${n}</b>.</p>
         <p class="valeur">Score estimé : ${scoreEstime(v1)} avec la main 1,
            ${scoreEstime(v2)} avec la main 2.</p>`,
        [boutonFermer(), { texte: `Garder la main ${n}`, action: () => { fermerPanneau(); garderMain(n); } }]);
      break;
    }
    case CHOIX_CASE: {
      const options = a.options(partie.des, partie.sec).slice(0, 5);
      const lignes = options.map((o, i) =>
        `<tr class="${i === 0 ? "conseille" : ""}">
           <td>${COLONNES[o.colonne]} / ${LIGNES[o.ligne]}</td>
           <td>${o.barree ? "barrer" : `${o.points} pt`}</td>
           <td>${scoreEstime(o.valeur)}</td>
         </tr>`).join("");
      const meilleure = options[0];
      ouvrirPanneau("Conseil",
        `<p>Les meilleures cases avec ces dés :</p><table>${lignes}</table>
         <p class="valeur">La dernière colonne est le score final que l'IA estime
            si l'on joue cette case.</p>`,
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
         <p class="valeur">À partir de cette feuille, l'IA estime un score final
            moyen de <b>${scoreEstime(a.valeur)}</b>.</p>`,
        [boutonFermer(), { texte: "Lancer les dés", action: () => { fermerPanneau(); lancer(); } }]);
  }
}

/// Relance les des que le conseil designe, sans etape intermediaire.
///
/// Une premiere version se contentait de les cocher, laissant le joueur appuyer
/// ensuite sur « Relancer » — deux gestes pour une seule decision, alors que
/// « Tout relancer » en demandait deja un seul. Les deux boutons du conseil
/// agissent donc pareil.
///
/// Le conseil rend des **faces** (`[1, 2, 3]`), pas des positions : il faut les
/// apparier, en veillant a ne pas cocher deux fois le meme de.
function relancerConseilles(faces) {
  partie.relance = [false, false, false, false, false];
  for (const face of faces) {
    const i = partie.des.findIndex((v, k) => v === face && !partie.relance[k]);
    if (i >= 0) partie.relance[i] = true;
  }
  lancer();
}

// ==========================================================================
//  La memoire : la partie en cours, et l'historique
//
//  Tout tient dans `localStorage`, qui est le seul stockage dont on ait besoin
//  ici : une feuille fait 48 entiers, une partie sauvegardee moins d'un
//  kilo-octet. Rien ne sort de l'appareil.
//
//  Il peut echouer — navigation privee, stockage plein, reglages du
//  navigateur — et jamais cela ne doit empecher de jouer. Chaque acces est donc
//  protege, et l'absence de memoire est un cas normal, pas une panne.
// ==========================================================================

const CLE_PARTIE = "yam.partie.v1";
const CLE_HISTORIQUE = "yam.historique.v1";
const HISTORIQUE_MAX = 50;

function lireMemoire(cle) {
  try {
    const t = localStorage.getItem(cle);
    return t ? JSON.parse(t) : null;
  } catch {
    return null;      // pas de stockage, ou contenu illisible
  }
}

function ecrireMemoire(cle, valeur) {
  try {
    localStorage.setItem(cle, JSON.stringify(valeur));
  } catch { /* tant pis : on joue sans memoire */ }
}

function oublierMemoire(cle) {
  try {
    localStorage.removeItem(cle);
  } catch { /* rien a faire */ }
}

/// Enregistre la partie en cours, ou efface la sauvegarde s'il n'y en a plus.
///
/// L'analyse du tour n'est **pas** sauvegardee : c'est un objet du moteur, et
/// elle se refait en 5 ms a la reprise depuis la feuille du joueur courant, qui
/// n'a pas change depuis le debut du tour.
function sauverPartie() {
  if (partie.joueurs.length === 0 || partie.etat === PARTIE_FINIE) {
    oublierMemoire(CLE_PARTIE);
    return;
  }
  ecrireMemoire(CLE_PARTIE, {
    mode: partie.mode,
    joueurs: partie.joueurs.map((j) => ({
      nom: j.nom, estIA: j.estIA, estVous: j.estVous, feuille: Array.from(j.feuille),
    })),
    courant: partie.courant, tour: partie.tour, etat: partie.etat,
    des: partie.des, relance: partie.relance, relances: partie.relances,
    sec: partie.sec, main1: partie.main1, main2: partie.main2, v1: partie.v1,
    iaAJoue: partie.iaAJoue, aideUtilisee: partie.aideUtilisee,
  });
}

/// La partie sauvegardee, si elle est exploitable.
function partieEnMemoire() {
  const s = lireMemoire(CLE_PARTIE);
  if (!s || !Array.isArray(s.joueurs) || s.joueurs.length === 0) return null;
  if (s.joueurs.some((j) => !Array.isArray(j.feuille) || j.feuille.length !== constantes.NB_CASES)) {
    return null;    // format d'une autre version : on l'ignore plutot que de planter
  }
  return s;
}

function reprendrePartie() {
  const s = partieEnMemoire();
  if (!s) return false;

  Object.assign(partie, {
    mode: s.mode,
    joueurs: s.joueurs.map((j) => ({ ...j, feuille: Int32Array.from(j.feuille) })),
    courant: s.courant, tour: s.tour, etat: s.etat,
    des: s.des || [], relance: s.relance || [], relances: s.relances,
    sec: s.sec, main1: s.main1, main2: s.main2, v1: s.v1,
    iaAJoue: !!s.iaAJoue, aideUtilisee: !!s.aideUtilisee, analyse: null,
  });
  partie.vu = partie.courant;

  $("accueil").classList.add("cache");
  $("jeu").classList.remove("cache");

  // On ne sauvegarde un etat « au tour de l'IA » qu'apres qu'elle a joue : sa
  // feuille est donc a jour, et il ne reste qu'a passer au joueur suivant.
  if (partie.joueurs[partie.courant].estIA && partie.iaAJoue) {
    avancerApresIA();
    return true;
  }
  partie.analyse = moteur.analyser(partie.joueurs[partie.courant].feuille);
  rendre();
  return true;
}

/// Un resume d'une ligne, pour le bouton de reprise.
function resumeParties(s) {
  const nom = { seul: "Seul", ia: "Contre l'IA", duo: "À deux" }[s.mode] || s.mode;
  const scores = s.joueurs.map((j) => moteur.scoreTotal(Int32Array.from(j.feuille)));
  return `${nom} — tour ${s.tour} sur ${constantes.NB_CASES}, ${scores.join(" contre ")} points`;
}

// --- L'historique ---------------------------------------------------------

function lireHistorique() {
  const h = lireMemoire(CLE_HISTORIQUE);
  return Array.isArray(h) ? h : [];
}

function inscrireAuxArchives(scores) {
  const h = lireHistorique();
  h.unshift({ date: Date.now(), mode: partie.mode, scores, aide: partie.aideUtilisee });
  ecrireMemoire(CLE_HISTORIQUE, h.slice(0, HISTORIQUE_MAX));
}

function montrerHistorique() {
  const h = lireHistorique();
  if (h.length === 0) {
    ouvrirPanneau("Parties précédentes",
      "<p>Aucune partie terminée pour l'instant.</p>", [boutonFermer()]);
    return;
  }
  // Le meilleur score personnel, tous modes confondus : c'est le chiffre qu'on
  // vient chercher dans un historique.
  const miens = h.flatMap((p) => p.scores.filter((s) => s.estVous !== false).map((s) => s.score));
  const record = miens.length ? Math.max(...miens) : null;

  const quand = (t) => new Date(t).toLocaleDateString("fr-FR",
    { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const nomMode = { seul: "Seul", ia: "IA", duo: "À deux" };

  const lignes = h.map((p) => {
    const detail = p.scores.map((s) => `${s.score}`).join(" − ");
    const record_ici = record !== null && p.scores.some((s) => s.estVous !== false && s.score === record);
    // `p.aide` est absent des parties archivees avant que ce drapeau existe :
    // pas d'etiquette, plutot qu'une affirmation qu'on ne peut pas verifier.
    const aide = p.aide ? ' <span class="etiquette">avec aide</span>' : "";
    return `<tr class="${record_ici ? "conseille" : ""}">
              <td>${quand(p.date)}</td>
              <td>${nomMode[p.mode] || p.mode}${aide}</td>
              <td>${detail}</td>
            </tr>`;
  }).join("");

  ouvrirPanneau("Parties précédentes",
    (record !== null ? `<p>Meilleur score : <b>${record}</b>.</p>` : "") +
    `<table>${lignes}</table>` +
    `<p class="valeur">${h.length} partie${h.length > 1 ? "s" : ""} conservée${h.length > 1 ? "s" : ""},
        sur cet appareil seulement.</p>`,
    [boutonFermer(),
     { texte: "Tout effacer", secondaire: true, action: async () => {
         fermerPanneau();
         if (await confirmer("Effacer l'historique ?",
             "Les parties précédentes seront définitivement oubliées.",
             "Effacer", "Annuler")) {
           oublierMemoire(CLE_HISTORIQUE);
           rafraichirAccueil();
         }
       } }]);
}

// --- L'accueil ------------------------------------------------------------

/// Met l'accueil au diapason de ce qu'il y a en memoire.
function rafraichirAccueil() {
  const s = partieEnMemoire();
  const bouton = $("bouton-reprendre");
  bouton.classList.toggle("cache", !s);
  if (s) $("reprise-detail").textContent = resumeParties(s);
  $("bouton-historique").classList.toggle("cache", lireHistorique().length === 0);
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
      { texte: "Nouvelle partie", action: () => { fermerPanneau(); rejouer(); } },
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
    installerServiceWorker();
  } else {
    // On defait ce qu'une visite precedente aurait pu installer.
    navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister()));
    if (window.caches) caches.keys().then((noms) => noms.forEach((n) => caches.delete(n)));
  }
}

/// L'enregistrement du service worker, une fois obtenu.
///
/// C'est **lui** qui dit s'il y a une mise a jour en attente, via son champ
/// `waiting`. Une premiere version memorisait le worker de son cote, au signal
/// `updatefound` : deux etats a garder d'accord, et ils ont diverge des le
/// premier essai — l'evenement etait manque, la mise a jour restait invisible
/// alors qu'elle attendait. Un seul etat, lu a la source, ne peut pas mentir.
let enregistrementSW = null;

async function installerServiceWorker() {
  try {
    enregistrementSW = await navigator.serviceWorker.register("./sw.js");
  } catch {
    return;   // sans hors-ligne, mais le jeu marche
  }
  const r = enregistrementSW;

  // Une mise a jour peut deja attendre, telechargee lors d'une visite
  // precedente et jamais acceptee.
  surveiller(r.waiting);
  r.addEventListener("updatefound", () => surveiller(r.installing));

  // La nouvelle version prend la main : on recharge pour la faire tourner.
  let rechargement = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (rechargement) return;      // `controllerchange` peut se produire deux fois
    rechargement = true;
    location.reload();
  });

  // Une application lancee depuis l'ecran d'accueil est souvent *reprise*
  // plutot que rechargee : sans cela, elle pourrait ne jamais rien demander au
  // reseau et rester indefiniment sur son ancienne version.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) r.update().catch(() => {});
  });
}

/// Suit un service worker jusqu'a ce qu'il soit installe, puis propose.
///
/// `controller` est nul a la toute premiere installation : ce n'est pas une
/// mise a jour, il n'y a rien a proposer.
function surveiller(worker) {
  if (!worker || !navigator.serviceWorker.controller) return;
  const verifier = () => {
    if (worker.state === "installed") proposerMiseAJour();
  };
  worker.addEventListener("statechange", verifier);
  // Il peut deja etre installe : `statechange` ne se rejouerait pas.
  verifier();
}

/// Propose la mise a jour, mais **jamais au milieu d'une partie**.
///
/// L'accepter recharge la page, et une partie en cours n'est sauvegardee nulle
/// part : elle serait perdue. On attend donc d'etre revenu a l'accueil, ou
/// `retourAccueil` rappelle cette fonction. La nouvelle version est deja
/// telechargee pendant ce temps — le joueur n'attend rien le moment venu.
function proposerMiseAJour() {
  const worker = enregistrementSW && enregistrementSW.waiting;
  if (!worker) return;
  if ($("accueil").classList.contains("cache")) return;   // une partie est en cours
  ouvrirPanneau("Nouvelle version",
    `<p>Une nouvelle version du jeu est prête.</p>
     <p class="valeur">Elle est déjà téléchargée : la mise à jour est immédiate,
        et le jeu continue de fonctionner hors ligne.</p>`,
    [
      { texte: "Plus tard", secondaire: true, action: () => fermerPanneau() },
      { texte: "Mettre à jour", action: () => { fermerPanneau(); worker.postMessage("activer"); } },
    ]);
}

demarrerModule();
