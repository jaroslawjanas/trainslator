import { describe, expect, it } from "vitest";
import { EpubBook } from "../epub/book.ts";
import { buildSegments } from "../epub/segments.ts";
import { mentionsAny } from "../kb/match.ts";
import { computeRefs, normalizeKey } from "../kb/model.ts";
import { titleNumbers } from "../pipeline/alignment.ts";
import { SAMPLE_NOVELS, sampleNovelIn } from "../testing/sample-novels.ts";
import { languageData, matterMatchers, SOURCE_LANGUAGES } from "./index.ts";

/**
 * A few titles, names and keys for each language file beyond English, German
 * and Polish (those have their own tests), so a change to a file that breaks
 * one shows up here.
 */
interface Sample {
  /** Titles guessed as front matter, and as back matter. */
  front: string[];
  back: string[];
  /** Titles that are neither. */
  notMatter: string[];
  /** Chapter titles with the number they name. */
  numbers: [string, number][];
  /** A name or term in base form, and text that has it inflected. */
  inflected?: [string, string][];
  /** A name or term, and text that only has a similar word. */
  notFound?: [string, string][];
  /** Two forms that must get the same name key (an article dropped). */
  keyPairs?: [string, string][];
}

const SAMPLES: Record<string, Sample> = {
  es: {
    front: ["Índice", "Créditos", "Dedicatoria"],
    back: ["Agradecimientos", "Sobre la autora", "Nota del traductor"],
    notMatter: ["Capítulo uno", "Prólogo"],
    numbers: [
      ["Capítulo doce", 12],
      ["Capítulo primero", 1],
      ["Segunda parte", 2],
    ],
    keyPairs: [
      ["El Caballero Negro", "Caballero Negro"],
      ["la Orden", "Orden"],
    ],
  },
  pt: {
    front: ["Sumário", "Folha de rosto", "Dedicatória"],
    back: ["Agradecimentos", "Sobre o autor", "Nota do tradutor"],
    notMatter: ["Capítulo um", "Prólogo"],
    numbers: [
      ["Capítulo doze", 12],
      ["Capítulo primeiro", 1],
      ["Segunda parte", 2],
    ],
    keyPairs: [
      ["O Cavaleiro Negro", "Cavaleiro Negro"],
      ["a Ordem", "Ordem"],
    ],
  },
  it: {
    front: ["Indice", "Frontespizio", "Dedica"],
    back: ["Ringraziamenti", "Nota del traduttore", "L’autore"],
    notMatter: ["Capitolo uno", "Prologo"],
    numbers: [
      ["Capitolo dodici", 12],
      ["Capitolo primo", 1],
      ["Seconda parte", 2],
    ],
    keyPairs: [
      ["L’Ordine", "Ordine"],
      ["il Cavaliere Nero", "Cavaliere Nero"],
      ["Un’isola", "isola"],
    ],
  },
  fr: {
    front: ["Table des matières", "Dédicace", "Page de titre"],
    back: ["Remerciements", "Du même auteur", "À propos de l’autrice"],
    notMatter: ["Chapitre un", "Prologue"],
    numbers: [
      ["Chapitre douze", 12],
      ["Chapitre premier", 1],
      ["Deuxième partie", 2],
    ],
    keyPairs: [
      ["L’Ordre", "Ordre"],
      ["l'Ordre", "Ordre"],
      ["le Chevalier noir", "Chevalier noir"],
    ],
  },
  ca: {
    front: ["Índex", "Sumari", "Dedicatòria"],
    back: ["Agraïments", "Sobre l’autora", "Nota del traductor"],
    notMatter: ["Capítol u", "Pròleg"],
    numbers: [
      ["Capítol dotze", 12],
      ["Capítol primer", 1],
      ["Segona part", 2],
    ],
    keyPairs: [
      ["L’Orde", "Orde"],
      ["en Joan", "Joan"],
      ["el Cavaller Negre", "Cavaller Negre"],
    ],
  },
  ro: {
    front: ["Cuprins", "Dedicație", "Pagina de titlu"],
    back: ["Mulțumiri", "Despre autor", "Nota traducătorului"],
    notMatter: ["Capitolul unu", "Prolog"],
    numbers: [
      ["Capitolul doisprezece", 12],
      ["Capitolul întâi", 1],
      ["Partea a doua", 2],
      ["Capitolul al doilea", 2],
    ],
    inflected: [
      ["Ion", "Fiul Ionului plecase devreme."],
      ["Maria", "I-a dat Mariei scrisoarea."],
      ["București", "Străzile Bucureștiului erau goale."],
      ["România", "Istoria României e lungă."],
    ],
    notFound: [
      ["Ion", "Ionescu a venit acasă."],
      ["Maria", "Marin a plecat."],
    ],
    keyPairs: [["un Castel", "Castel"]],
  },
  nl: {
    front: ["Inhoudsopgave", "Inhoud", "Colofon"],
    back: ["Dankwoord", "Over de auteur", "Noot van de vertaler"],
    notMatter: ["Hoofdstuk een", "Proloog"],
    numbers: [
      ["Hoofdstuk twaalf", 12],
      ["Eerste hoofdstuk", 1],
      ["Twintigste hoofdstuk", 20],
      ["Deel twee", 2],
    ],
    inflected: [
      ["Jan", "Dat was Jans fiets."],
      ["Zwarte Toren", "Ze liepen naar de Zwarte Torens."],
    ],
    notFound: [["Jan", "Januari was koud."]],
    keyPairs: [
      ["de Zwarte Toren", "Zwarte Toren"],
      ["het Woud", "Woud"],
    ],
  },
  sv: {
    front: ["Innehåll", "Innehållsförteckning", "Tillägnan"],
    back: ["Tack", "Om författaren", "Ordlista"],
    notMatter: ["Kapitel ett", "Prolog"],
    numbers: [
      ["Kapitel tolv", 12],
      ["Första kapitlet", 1],
      ["Kapitel tjugo", 20],
      ["Andra delen", 2],
    ],
    inflected: [
      ["Anna", "Det var Annas bok."],
      ["Riddare", "Riddaren red bort."],
      ["Stockholm", "Han for till Stockholms hamn."],
    ],
    notFound: [["Anna", "Annika kom hem."]],
    keyPairs: [
      ["den svarta riddaren", "svarta riddaren"],
      ["ett torn", "torn"],
    ],
  },
  da: {
    front: ["Indholdsfortegnelse", "Indhold", "Kolofon"],
    back: ["Tak", "Om forfatteren", "Noter"],
    notMatter: ["Kapitel et", "Prolog"],
    numbers: [
      ["Kapitel tolv", 12],
      ["Første kapitel", 1],
      ["Kapitel tyve", 20],
      ["Anden del", 2],
    ],
    inflected: [
      ["Anna", "Det var Annas bog."],
      ["Ridder", "Ridderen red væk."],
      ["København", "Han kom fra Københavns havn."],
    ],
    notFound: [["Anna", "Annika kom hjem."]],
    keyPairs: [
      ["den sorte ridder", "sorte ridder"],
      ["et tårn", "tårn"],
    ],
  },
  nb: {
    front: ["Innholdsfortegnelse", "Innhold", "Tittelside"],
    back: ["Takk", "Om forfatteren", "Ordliste"],
    notMatter: ["Kapittel en", "Prolog"],
    numbers: [
      ["Kapittel tolv", 12],
      ["Første kapittel", 1],
      ["Kapittel tjue", 20],
      ["Andre del", 2],
    ],
    inflected: [
      ["Anna", "Det var Annas bok."],
      ["Ridder", "Ridderen red bort."],
      ["Oslo", "Han kom fra Oslos havn."],
    ],
    notFound: [["Anna", "Annika kom hjem."]],
    keyPairs: [
      ["den svarte ridderen", "svarte ridderen"],
      ["ei bok", "bok"],
    ],
  },
  cs: {
    front: ["Obsah", "Věnování", "Titulní strana"],
    back: ["Poděkování", "Poznámky", "O autorce"],
    notMatter: ["Kapitola první", "Prolog", "Obsahová stránka"],
    numbers: [
      ["Kapitola dvanáct", 12],
      ["Kapitola první", 1],
      ["Část druhá", 2],
      ["Kapitola dvacátá první", 21],
    ],
    inflected: [
      ["Praha", "Bydlel v Praze."],
      ["Petr", "Dala to Petrovi."],
      ["Petr", "Mluvila o Petře."],
      ["Karel", "Neviděla Karla od jara."],
      ["Olga", "Řekl to Olze."],
    ],
    notFound: [
      ["Petr", "Přišel Petrák."],
      ["Karel", "Koupil karafu."],
    ],
  },
  sk: {
    front: ["Obsah", "Venovanie"],
    back: ["Poďakovanie", "Poznámky", "O autorke"],
    notMatter: ["Kapitola prvá", "Prológ"],
    numbers: [
      ["Kapitola dvanásť", 12],
      ["Kapitola prvá", 1],
      ["Časť druhá", 2],
    ],
    inflected: [
      ["Bratislava", "Žil v Bratislave."],
      ["Peter", "Dala list Petrovi."],
      ["Marek", "Čakali na Marka."],
      ["Košice", "Býval v Košiciach."],
    ],
    notFound: [["Peter", "Bývali v Petržalke."]],
  },
  hr: {
    front: ["Sadržaj", "Posveta"],
    back: ["Zahvale", "Bilješke", "O autorici"],
    notMatter: ["Poglavlje prvo", "Prolog"],
    numbers: [
      ["Poglavlje dvanaest", 12],
      ["Poglavlje prvo", 1],
      ["Dio drugi", 2],
    ],
    inflected: [
      ["Zagreb", "Živio je u Zagrebu."],
      ["Rijeka", "Stanovala je u Rijeci."],
      ["Pavao", "Čekali su Pavla."],
      ["Katarina", "Nije bilo Katarine."],
    ],
    notFound: [
      ["Ivan", "Došla je Ivanka."],
      ["Petar", "Zvao se Petrović."],
    ],
  },
  sl: {
    front: ["Kazalo", "Vsebina", "Posvetilo"],
    back: ["Zahvala", "Opombe", "O avtorju"],
    notMatter: ["Poglavje prvo", "Prolog"],
    numbers: [
      ["Poglavje dvanajst", 12],
      ["Poglavje prvo", 1],
      ["Del drugi", 2],
    ],
    inflected: [
      ["Ljubljana", "Živel je v Ljubljani."],
      ["Tone", "Čakali so Toneta."],
      ["Igor", "Dal je knjigo Igorju."],
    ],
    notFound: [["Janez", "Prišel je Janezek."]],
  },
  sr: {
    front: ["Садржај", "Посвета", "Sadržaj", "Posveta"],
    back: ["Захвалност", "Белешке", "О аутору", "Beleške", "O autorki"],
    notMatter: ["Поглавље прво", "Пролог", "Poglavlje prvo", "Prolog"],
    numbers: [
      ["Поглавље дванаест", 12],
      ["Глава прва", 1],
      ["Poglavlje dvanaest", 12],
      ["Deo drugi", 2],
    ],
    inflected: [
      ["Београд", "Живео је у Београду."],
      ["Петар", "Није видела Петра."],
      ["Beograd", "Živeo je u Beogradu."],
      ["Pavle", "Dala je knjigu Pavlu."],
    ],
    notFound: [
      ["Петар", "Звао се Петровић."],
      ["Petar", "Zvao se Petrović."],
    ],
  },
  ru: {
    front: ["Содержание", "Аннотация", "Выходные данные"],
    back: ["Примечания переводчика", "Благодарности", "Об авторе"],
    notMatter: ["Глава первая", "Пролог"],
    numbers: [
      ["Глава двенадцатая", 12],
      ["Часть вторая", 2],
      ["Глава двадцать первая", 21],
      ["Глава пятнадцать", 15],
    ],
    inflected: [
      ["Пётр", "Она ждала Петра."],
      ["Москва", "Он жил в Москве."],
      ["Москва", "Они уехали из Москвы."],
      ["Колобок", "Лиса съела Колобка."],
      ["Чёрная Башня", "Он подошёл к Черной Башне."],
    ],
    notFound: [
      ["Анна", "Пришла Аннушка."],
      ["Пётр", "Пришёл Петрович."],
    ],
  },
  uk: {
    front: ["Зміст", "Анотація", "Присвята"],
    back: ["Примітки перекладача", "Подяки", "Про авторку"],
    notMatter: ["Розділ перший", "Пролог"],
    numbers: [
      ["Розділ перший", 1],
      ["Частина друга", 2],
      ["Розділ дванадцятий", 12],
      ["Розділ двадцять третій", 23],
    ],
    inflected: [
      ["Львів", "Вони поїхали до Львова."],
      ["Київ", "Він жив у Києві."],
      ["Тарас", "Тарасе, ходи сюди!"],
    ],
    notFound: [["Іван", "Прийшов Іванко."]],
  },
  bg: {
    front: ["Съдържание", "Посвещение"],
    back: ["Бележки на преводача", "Благодарности", "За автора"],
    notMatter: ["Глава първа", "Пролог"],
    numbers: [
      ["Глава първа", 1],
      ["Част втора", 2],
      ["Глава дванадесета", 12],
    ],
    inflected: [
      ["Орден", "Рицарите на Ордена чакаха."],
      ["Замък", "Замъкът беше тих."],
    ],
    notFound: [["Иван", "Дойде Иванка."]],
  },
  el: {
    front: ["Περιεχόμενα", "ΠΕΡΙΕΧΟΜΕΝΑ", "Αφιέρωση"],
    back: ["Ευχαριστίες", "Σημειώσεις του μεταφραστή", "Για τον συγγραφέα"],
    notMatter: ["Κεφάλαιο πρώτο", "Πρόλογος"],
    numbers: [
      ["Κεφάλαιο πρώτο", 1],
      ["ΚΕΦΑΛΑΙΟ ΔΕΥΤΕΡΟ", 2],
      ["Μέρος τρίτο", 3],
      ["Κεφάλαιο δώδεκα", 12],
      ["Κεφάλαιο εικοστό πρώτο", 21],
    ],
    inflected: [
      ["Αθήνα", "Οι δρόμοι των Αθηνών ήταν άδειοι."],
      ["Νίκος", "Το σπίτι του Νίκου ήταν μικρό."],
      ["Γιάννης", "Είδε τον Γιάννη στον δρόμο."],
    ],
    notFound: [["Νίκος", "Ήρθε ο Νικόλαος."]],
    keyPairs: [
      ["ο Γιάννης", "Γιάννης"],
      ["η Αθήνα", "Αθήνα"],
    ],
  },
  id: {
    front: ["Daftar Isi", "Hak Cipta", "Persembahan"],
    back: ["Ucapan Terima Kasih", "Tentang Penulis", "Daftar Pustaka"],
    notMatter: ["Bab Satu", "Prolog"],
    numbers: [
      ["Bab Satu", 1],
      ["Bagian Kedua", 2],
      ["Bab Sebelas", 11],
    ],
    inflected: [
      ["Rumah", "Rumahnya besar sekali."],
      ["Jakarta", "Jakartalah kota terbesar."],
    ],
    notFound: [["Rumah", "Rumahan itu kosong."]],
  },
  ms: {
    front: ["Kandungan", "Isi Kandungan", "Hak Cipta"],
    back: ["Penghargaan", "Tentang Penulis", "Nota"],
    notMatter: ["Bab Satu", "Prolog"],
    numbers: [
      ["Bab Lapan", 8],
      ["Bahagian Kedua", 2],
      ["Bab Sebelas", 11],
    ],
    inflected: [
      ["Rumah", "Rumahnya besar sekali."],
      ["Melaka", "Melakalah bandar itu."],
    ],
    notFound: [["Rumah", "Rumahan itu kosong."]],
  },
  fil: {
    front: ["Talaan ng Nilalaman", "Pabalat", "Paghahandog"],
    back: ["Pasasalamat", "Tungkol sa May-akda", "Glosaryo"],
    notMatter: ["Kabanata Isa", "Prologo"],
    numbers: [
      ["Kabanata Isa", 1],
      ["Unang Kabanata", 1],
      ["Ikalawang Bahagi", 2],
      ["Kabanata Labindalawa", 12],
    ],
    inflected: [["Maria", "Si Mariang maganda ay dumating."]],
    notFound: [["Maria", "Si Mariano ay umalis."]],
    keyPairs: [
      ["ang Itim na Kabalyero", "Itim na Kabalyero"],
      ["ang mga Diwata", "Diwata"],
    ],
  },
};

it("has samples for every source language beyond English, German and Polish", () => {
  expect(Object.keys(SAMPLES).sort()).toEqual(
    SOURCE_LANGUAGES.filter((t) => !["en", "de", "pl"].includes(t)).sort(),
  );
});

describe.each(Object.entries(SAMPLES))("the %s file", (tag, sample) => {
  it("guesses front and back matter by title", () => {
    const { front, back } = matterMatchers(tag);
    for (const title of sample.front) expect([title, front!.test(title)]).toEqual([title, true]);
    for (const title of sample.back) expect([title, back!.test(title)]).toEqual([title, true]);
    for (const title of sample.notMatter)
      expect([title, front!.test(title) || back!.test(title)]).toEqual([title, false]);
  });

  it("reads chapter numbers written as words", () => {
    for (const [title, n] of sample.numbers)
      expect([title, titleNumbers(title, tag)]).toEqual([title, [n]]);
  });

  it("finds names in the forms the text uses, and only those", () => {
    const data = languageData(tag)!;
    for (const [term, text] of sample.inflected ?? [])
      expect([term, text, mentionsAny([term], text, data)]).toEqual([term, text, true]);
    for (const [term, text] of sample.notFound ?? [])
      expect([term, text, mentionsAny([term], text, data)]).toEqual([term, text, false]);
  });

  it("ignores articles in name keys", () => {
    for (const [a, b] of sample.keyPairs ?? [])
      expect([a, normalizeKey(a, tag)]).toEqual([a, normalizeKey(b, tag)]);
  });
});

// The live smoke test's sample novels: what phase 2 needs from each word file.
describe.each(Object.entries(SAMPLE_NOVELS))("the %s sample novel", (tag, novel) => {
  it("is guessed as front matter, two chapters and back matter", () => {
    const segments = buildSegments(EpubBook.open(sampleNovelIn(tag)), tag).segmentsByDepth["1"]!;
    expect(segments.map((s) => [s.title, s.guess])).toEqual([
      [novel.contents, "front"],
      [novel.chapters[0]![0], "body"],
      [novel.chapters[1]![0], "body"],
      [novel.back[0], "back"],
    ]);
    expect(novel.chapters.map(([title]) => titleNumbers(title, tag))).toEqual([[1], [2]]);
  });

  it("names its names in the first chapter, inflected forms included", () => {
    const text = novel.chapters[0]![1].join("\n");
    for (const name of novel.names)
      expect([name, computeRefs({ source: name, aliases: [] }, [{ id: "c1", text }], tag)]).toEqual(
        [name, ["c1"]],
      );
  });
});
