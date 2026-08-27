// ==========================================================================
//  Service worker — le hors-ligne.
//
//  Strategie : « cache d'abord ». C'est le bon choix ici, et non le compromis
//  habituel : l'application est **entierement locale**, il n'y a ni serveur de
//  parties ni donnees a rafraichir. Une fois les six fichiers en cache, le jeu
//  n'a plus jamais besoin du reseau.
//
//  La mise a jour passe donc par le numero de version ci-dessous : le changer
//  invalide tout l'ancien cache. C'est brutal et c'est voulu — le module
//  WebAssembly et la colle JavaScript doivent toujours aller ensemble, un
//  melange des deux versions donnerait des erreurs incomprehensibles.
//
//  Rappel : un service worker exige un contexte securise. `localhost` est
//  dispense, une adresse de reseau local en clair (http://192.168.x.x) ne
//  l'est pas — le jeu y fonctionne, mais sans hors-ligne.
// ==========================================================================

//  ATTENTION : ce numero est le SEUL mecanisme de mise a jour. Tant qu'il ne
//  change pas, une installation existante continuera de servir ses anciens
//  fichiers, indefiniment. **A incrementer des qu'un fichier de `web/` change.**
const VERSION = "yam-0eb6bebb";

const FICHIERS = [
  "./",
  "./index.html",
  "./jeu.css",
  "./jeu.js",
  "./yam.js",
  "./yam_wasm.wasm",
  "./manifest.webmanifest",
  "./icone-192.png",
  "./icone-512.png",
  "./icone-maskable-512.png",
];

/// Les requetes d'installation, **hors cache HTTP**.
///
/// `cache.addAll(["./jeu.js", ...])` passe par le cache HTTP du navigateur. Or
/// GitHub Pages sert ces fichiers avec `max-age=600` : pendant dix minutes
/// apres une mise en ligne, le nouveau `sw.js` s'installe et remplit son cache
/// avec les **anciens** fichiers. Le piege s'est referme une fois : le cache
/// `yam-5d80f98d` contenait un `jeu.js` de la version precedente, et le jeu
/// tournait donc sur deux versions a la fois — exactement ce que le numero de
/// version existe pour empecher.
///
/// `cache: "reload"` force le reseau pour chacun de ces fichiers. C'est le
/// moment de le faire : on installe une version, elle doit etre entiere.
const A_INSTALLER = FICHIERS.map((f) => new Request(f, { cache: "reload" }));

self.addEventListener("install", (e) => {
  // Pas de `skipWaiting()` ici, volontairement : le nouveau service worker
  // reste en attente jusqu'a ce que le joueur accepte la mise a jour.
  //
  // Prendre la main tout de suite serait pire que ca en a l'air. La page en
  // cours a deja charge son JavaScript et son module WebAssembly ; lui changer
  // son service worker sous les pieds ne les remplace pas, mais met en place
  // un cache d'une autre version pour tout ce qu'elle demanderait ensuite. On
  // aurait alors deux versions melangees dans un meme onglet, ce qui est la
  // panne la moins comprehensible qui soit. Et le joueur, lui, ne verrait
  // toujours rien de nouveau avant d'avoir relance l'application deux fois.
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(A_INSTALLER)));
});

// La page demande l'activation quand le joueur a accepte. Elle se rechargera
// sur `controllerchange`, donc au moment ou la nouvelle version prend la main.
self.addEventListener("message", (e) => {
  if (e.data === "activer") self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((noms) => Promise.all(noms.filter((n) => n !== VERSION).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  // On ne s'occupe que de nos propres fichiers, et seulement en lecture.
  if (e.request.method !== "GET") return;

  // Une requete portant un parametre demande explicitement a contourner les
  // caches : c'est ce que fait `banc.html`, qui horodate ses imports pour ne
  // pas mesurer le module precedent. Servir le cache ici reintroduirait
  // exactement le piege que ce parametre existe pour eviter.
  if (new URL(e.request.url).search) return;

  e.respondWith(
    caches.match(e.request)
      .then((reponse) => reponse || fetch(e.request)));
});
