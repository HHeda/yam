// =============================================================================
//  yam.js — la colle entre le module WebAssembly et l'interface
//
//  Elle tient lieu de ce que `wasm-bindgen` aurait engendre ; voir l'en-tete de
//  `src/lib.rs` pour la raison de ce choix. Tout le contrat memoire est ici, et
//  nulle part ailleurs : l'interface ne manipule jamais un pointeur.
// =============================================================================

/// Le moteur, cote JavaScript. Mono-instance, comme le module lui-meme.
export class Moteur {
  #ex;        // les exports du module
  #memoire;   // l'objet WebAssembly.Memory
  #decodeur = new TextDecoder("utf-8");

  /// Constantes du jeu, lues au moteur pour qu'elles ne puissent pas diverger.
  constantes;

  /**
   * Charge et prepare le module.
   *
   * @param {string} url      chemin du .wasm
   * @param {object} options  `avecReseau` (defaut vrai) choisit le reseau
   *                          entraine plutot que l'heuristique V0 ; `graine`
   *                          amorce le generateur, tiree au sort si absente.
   */
  static async charger(url = "./yam_wasm.wasm", { avecReseau = true, graine } = {}) {
    const m = new Moteur();
    // `instantiateStreaming` exige le type MIME application/wasm ; on retombe
    // sur la variante tamponnee si le serveur ne le sert pas, ce qui arrive
    // avec bien des serveurs de developpement.
    let module;
    try {
      module = await WebAssembly.instantiateStreaming(fetch(url), {});
    } catch {
      module = await WebAssembly.instantiate(await (await fetch(url)).arrayBuffer(), {});
    }
    m.#ex = module.instance.exports;
    m.#memoire = m.#ex.memory;

    if (graine === undefined) {
      // Le module n'a aucune source d'alea : c'est le navigateur qui la donne.
      //
      // On tire deux mots de 32 bits plutot qu'un `BigUint64Array` : les
      // tableaux types 64 bits ne sont acceptes par `getRandomValues` que
      // depuis une revision tardive de la specification, et Safari a mis du
      // temps a suivre. Deux `Uint32` marchent partout.
      const mots = new Uint32Array(2);
      crypto.getRandomValues(mots);
      graine = (BigInt(mots[0]) << 32n) | BigInt(mots[1]);
    }
    m.#verifier(m.#ex.yam_init(avecReseau ? 1 : 0, graine));
    m.#verifier(m.#ex.yam_constantes());
    m.constantes = JSON.parse(m.#lireSortie());
    return m;
  }

  // --- Le contrat memoire -------------------------------------------------
  //
  // Les vues sont reconstruites a chaque acces : `memory.buffer` est detache
  // des que le tas WebAssembly grandit, et une vue conservee devient alors
  // silencieusement vide. C'est le piege classique de ce genre de passerelle.

  get #feuille() {
    return new Int32Array(this.#memoire.buffer, this.#ex.yam_feuille_ptr(), this.constantes?.NB_CASES ?? 48);
  }

  get #des() {
    return new Uint8Array(this.#memoire.buffer, this.#ex.yam_des_ptr(), 10);
  }

  #lireSortie() {
    const n = this.#ex.yam_sortie_len();
    if (n === 0) return "";
    const octets = new Uint8Array(this.#memoire.buffer, this.#ex.yam_sortie_ptr(), n);
    return this.#decodeur.decode(octets);
  }

  /// Traduit le code de retour du module en exception JavaScript.
  #verifier(code) {
    if (code < 0) throw new Error(`yam_wasm : ${this.#lireSortie()}`);
    return code;
  }

  /// Le meme, pour les fonctions qui rendent NaN en cas d'echec.
  #verifierReel(v) {
    if (Number.isNaN(v)) throw new Error(`yam_wasm : ${this.#lireSortie()}`);
    return v;
  }

  /// Depose une main de des dans le tampon. `main` vaut 0 ou 1.
  #ecrireDes(des, main = 0) {
    if (des.length !== 5) throw new Error(`il faut 5 des, pas ${des.length}`);
    this.#des.set(des, main * 5);
  }

  // --- La feuille ---------------------------------------------------------

  /// Le nom de la fonction de valeur en place : « reseau entraine » ou
  /// « heuristique V0 ». Pour l'affichage.
  get nomValeur() {
    this.#verifier(this.#ex.yam_nom_valeur());
    return JSON.parse(this.#lireSortie());
  }

  /// Une feuille vide, sous forme de Int32Array de 48 cases.
  feuilleVide() {
    this.#ex.yam_feuille_vide();
    return this.lireFeuille();
  }

  /// Copie la feuille du tampon. La copie est indispensable : le tampon est
  /// reecrit par l'appel suivant.
  lireFeuille() {
    return this.#feuille.slice();
  }

  /// Depose une feuille dans le tampon.
  ecrireFeuille(feuille) {
    const n = this.constantes.NB_CASES;
    if (feuille.length !== n) throw new Error(`il faut ${n} cases, pas ${feuille.length}`);
    this.#feuille.set(feuille);
  }

  /// Indice plat d'une case, `feuille[colonne * 12 + ligne]`.
  indice(colonne, ligne) {
    return colonne * this.constantes.NB_LIGNES + ligne;
  }

  scoreTotal(feuille) {
    this.ecrireFeuille(feuille);
    const v = this.#ex.yam_score_total();
    if (v < 0) throw new Error(`yam_wasm : ${this.#lireSortie()}`);
    return v;
  }

  totauxColonne(feuille, colonne) {
    this.ecrireFeuille(feuille);
    this.#verifier(this.#ex.yam_totaux_colonne(colonne));
    return JSON.parse(this.#lireSortie());
  }

  estJouable(feuille, colonne, ligne, sec) {
    this.ecrireFeuille(feuille);
    const v = this.#ex.yam_est_jouable(colonne, ligne, sec ? 1 : 0);
    if (v < 0) throw new Error(`yam_wasm : ${this.#lireSortie()}`);
    return v === 1;
  }

  /// Points rapportes par ces des dans cette case, ou `null` si le contrat
  /// n'est pas rempli — la case ne peut alors qu'etre barree.
  points(feuille, colonne, ligne, des) {
    this.ecrireFeuille(feuille);
    this.#ecrireDes(des);
    const v = this.#ex.yam_points(colonne, ligne);
    if (v === -2) throw new Error(`yam_wasm : ${this.#lireSortie()}`);
    return v === -1 ? null : v;
  }

  valeurFeuille(feuille) {
    this.ecrireFeuille(feuille);
    return this.#verifierReel(this.#ex.yam_valeur_feuille());
  }

  // --- Le tour ------------------------------------------------------------

  /**
   * Analyse un tour. C'est **la** operation couteuse, a faire une fois par
   * tour : tous les conseils ci-dessous s'y adossent sans recalcul.
   */
  analyser(feuille) {
    this.ecrireFeuille(feuille);
    this.#verifier(this.#ex.yam_analyser());
    return new Analyse(this, this.#ex);
  }

  /// Fait jouer un tour entier par l'IA. Rend le deroule, feuille resultante
  /// comprise.
  jouerTour(feuille) {
    this.ecrireFeuille(feuille);
    this.#verifier(this.#ex.yam_jouer_tour());
    const deroule = JSON.parse(this.#lireSortie());
    deroule.feuille = this.lireFeuille();
    return deroule;
  }

  /// Lance `nb` des avec le generateur du moteur.
  lancer(nb = 5) {
    this.#verifier(this.#ex.yam_lancer(0, nb));
    return Array.from(this.#des.slice(0, nb));
  }

  // Ces deux methodes sont l'unique porte d'entree d'`Analyse` vers les
  // tampons : elles evitent d'exposer les champs prives de `Moteur`.
  _ecrireDes(des, main) { this.#ecrireDes(des, main); }
  _sortie() { return this.#lireSortie(); }
  _verifier(code) { return this.#verifier(code); }
  _verifierReel(v) { return this.#verifierReel(v); }
}

/**
 * Le resultat d'une analyse de tour. Toutes ses methodes sont gratuites : le
 * calcul a deja eu lieu.
 *
 * Une `Analyse` devient caduque des qu'on relance `analyser` ou `jouerTour` :
 * le module n'en retient qu'une.
 */
class Analyse {
  #m; #ex;
  constructor(moteur, exports) {
    this.#m = moteur;
    this.#ex = exports;
  }

  /// Valeur esperee du tour, avant tout lancer.
  get valeur() {
    return this.#m._verifierReel(this.#ex.yam_valeur());
  }

  /// Les cases jouables, en `[[colonne, ligne], ...]`.
  casesJouables(sec = true) {
    this.#m._verifier(this.#ex.yam_cases_jouables(sec ? 1 : 0));
    return JSON.parse(this.#m._sortie());
  }

  /// Valeur d'une main terminee : le meilleur coup possible avec ces des.
  valeurMain(des, sec) {
    this.#m._ecrireDes(des, 0);
    return this.#m._verifierReel(this.#ex.yam_valeur_main(sec ? 1 : 0));
  }

  /// Toutes les cases jouables avec ces des, de la meilleure a la pire.
  options(des, sec) {
    this.#m._ecrireDes(des, 0);
    this.#m._verifier(this.#ex.yam_options(sec ? 1 : 0));
    return JSON.parse(this.#m._sortie());
  }

  /// Meilleur coup avec ces des.
  meilleureCase(des, sec) {
    this.#m._ecrireDes(des, 0);
    this.#m._verifier(this.#ex.yam_meilleure_case(sec ? 1 : 0));
    return JSON.parse(this.#m._sortie());
  }

  /// Conseil pour la main 1 : s'arreter, ou quels des garder ?
  conseilMain1(des, relancesRestantes, sec) {
    this.#m._ecrireDes(des, 0);
    this.#m._verifier(this.#ex.yam_conseil_main1(relancesRestantes, sec ? 1 : 0));
    return JSON.parse(this.#m._sortie());
  }

  /// Conseil pour la main 2, connaissant la valeur `v1` obtenue en main 1.
  conseilMain2(des, relancesRestantes, sec, v1) {
    this.#m._ecrireDes(des, 0);
    this.#m._verifier(this.#ex.yam_conseil_main2(relancesRestantes, sec ? 1 : 0, v1));
    return JSON.parse(this.#m._sortie());
  }

  /// Quelle main garder, une fois les deux jouees ? Rend 1 ou 2.
  mainAGarder(des1, sec1, des2, sec2) {
    this.#m._ecrireDes(des1, 0);
    this.#m._ecrireDes(des2, 1);
    return this.#m._verifier(this.#ex.yam_main_a_garder(sec1 ? 1 : 0, sec2 ? 1 : 0));
  }
}
