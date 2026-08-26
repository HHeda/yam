# Yam

Le **Yam** en variante familiale française — feuille 12 lignes × 4 colonnes,
48 tours, deux mains par tour dont on garde la meilleure.

**[▶ Jouer](https://hheda.github.io/yam/)**

Trois modes : seul, contre l'IA, à deux sur le même téléphone. L'IA conseille
sur demande, jamais d'elle-même.

## C'est une application

Le jeu s'installe sur l'écran d'accueil et fonctionne **hors ligne** : tout le
calcul a lieu sur l'appareil, il n'y a aucun serveur à interroger.

- **iPhone** — ouvrir le lien dans Safari, bouton Partager → *Sur l'écran
  d'accueil*.
- **Android** — ouvrir le lien dans Chrome, menu ⋮ → *Installer l'application*.

## Ce qu'il y a dedans

Un moteur de Yam écrit en Rust et compilé en WebAssembly, avec un **solveur de
tour exact** : à chaque tour il résout la programmation dynamique complète des
deux mains, puis choisit la case. La fonction de valeur qui l'oriente est un
réseau de neurones entraîné par itération de politique, dont les poids sont
embarqués dans le module.

Une décision coûte 4,8 ms dans le navigateur. Le module fait 960 Kio, poids
compris, et le jeu n'a aucune dépendance JavaScript.

Ce dépôt ne contient que l'application compilée. Le moteur, l'entraînement et
les mesures vivent ailleurs.
