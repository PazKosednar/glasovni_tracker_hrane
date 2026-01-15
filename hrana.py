import speech_recognition as sr
import json
from pathlib import Path

ZIVILA_PATH = Path(__file__).parent / "zivila.json"

seznam_kolicin = {"enkrat": 1, "dvakrat": 2,
                  "trikrat": 3, "štirikrat": 4, "petkrat": 5, "ena": 1, "dva": 2, "tri": 3, "štiri": 4, "pet": 5}


def main():
    seznam_zivil = nalozi_zivila()
    seznam_zivil = {k.strip().lower(): v for k, v in seznam_zivil.items()}

    while True:
        print("== Povej hrano katero želiš vnesti(npr. dvakrat banana) ==")
        input("⏎ ENTER za začetek beleženja...")

        spoken_text = poslusaj()

        if spoken_text is None:
            print("Nič ni bilo prepoznano")
            print("=" * 35)
            continue

        if "izhod" in spoken_text.lower():
            print(f"Adijo! Se vidimo!")
            break

        razdeli = spoken_text.split()
        kolicina = razdeli[0]
        hrana = " ".join(razdeli[1:])
        hrana = hrana.strip().lower()
        hrana = hrana.replace(" ", "_")

        print("Uporabnik je rekel:", spoken_text.capitalize())

        faktor = 1
        if kolicina in seznam_kolicin:
            faktor = seznam_kolicin[kolicina]

        if hrana in seznam_zivil:
            zivilo = seznam_zivil[hrana]
            print("=" * 35)
            print(f"{hrana.capitalize()} dodan/a v jedilnik.")
            izpis_makro(zivilo, faktor)
            print("=" * 35)

        else:
            print("Ni v seznamu živil!")

        print()


def poslusaj(language="sl-SI"):
    r = sr.Recognizer()

    with sr.Microphone() as source:
        print("Kalibriram šum...")
        r.adjust_for_ambient_noise(source, duration=1)
        print("Govori...")
        audio = r.listen(source)

    try:
        text = r.recognize_google(audio, language=language)
        return text
    except:
        return None


def izpis_makro(zivilo, faktor):
    print(f"{zivilo['kcal'] * faktor} kalorij")
    print(f"{zivilo['beljakovine'] * faktor} beljakovin")
    print(
        f"{zivilo['ogljikovi_hidrati'] * faktor} ogljikovih hidratov")
    print(f"{zivilo['maščobe'] * faktor} maščob")


def nalozi_zivila(path: Path = ZIVILA_PATH) -> dict:
    if not path.exists():
        path.write_text("{}", encoding="utf-8")
        return {}

    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        print("Napaka: zivila.json ni veljaven JSON")
        return {}


if __name__ == "__main__":
    main()
