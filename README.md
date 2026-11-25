# Kalko – dnevnik kalorij

Spletna aplikacija (PWA) za iPhone: dodaš jo na začetni zaslon in deluje kot prava aplikacija.

## Funkcije
- **Skeniraj** – črtna koda s kamero → izdelek iz baze [Open Food Facts](https://world.openfoodfacts.org) (najprej iz Slovenije) → vpišeš težo → shrani.
- **Samodejni obrok** – vnos gre v zajtrk / kosilo / večerjo glede na uro (privzeto: zajtrk do 10:30, kosilo do 16:30). Meje spremeniš v Nastavitvah.
- **Slika** – fotografiraš krožnik, AI (Claude) prepozna živila in oceni grame ter kalorije. Pred shranjevanjem lahko popraviš.
- **Izdelka ni v bazi?** – ročni vnos ali **“Preberi z etikete (AI)”** (slikaš tabelo hranilnih vrednosti). Shrani se med “Moje izdelke” in se naslednjič najde takoj.
- **Išči** – po imenu/znamki, nedavna živila, moji izdelki.
- Dnevni cilj kcal + makrohranila, pregled po dnevih, izvoz/uvoz varnostne kopije.
- Vsi podatki so shranjeni **samo na telefonu** (localStorage).

## Namestitev na iPhone
1. Na GitHubu: **Settings → Pages → Build and deployment → Source: Deploy from a branch → `main` / `(root)`** → Save.
   (GitHub Pages za zasebne repozitorije zahteva plačljiv paket – sicer naj bo repo javen; podatki in API ključ niso v repozitoriju.)
2. Po minuti je aplikacija na `https://<uporabnik>.github.io/<ime-repozitorija>/`.
3. Odpri naslov v **Safariju** → gumb Deli → **Dodaj na začetni zaslon**.
4. Ob prvem skeniranju dovoli dostop do kamere.

## AI prepoznava (neobvezno)
- Na [console.anthropic.com](https://console.anthropic.com) ustvari API ključ in ga vpiši v Nastavitvah (⚙︎).
- Ključ je shranjen samo v telefonu. Priporočeno: v konzoli nastavi mesečno omejitev porabe.
- Vsaka slika = en klic (plačljivo po porabi). Ocene količin so približne.

## Datoteke
| Datoteka | Namen |
|---|---|
| `index.html` | struktura zaslona |
| `style.css` | svetla tema |
| `app.js` | vsa logika (baza, skener, AI, shranjevanje) |
| `manifest.webmanifest`, `sw.js`, `icons/` | namestitev na začetni zaslon, delovanje brez povezave |

Podatki o izdelkih: Open Food Facts (licenca ODbL).
