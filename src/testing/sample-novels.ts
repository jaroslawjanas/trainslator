import { buildFixtureEpub } from "./epub-fixtures.ts";

/**
 * The German sample's story (Anna waits at the Black Tower for the Order) in
 * the other source languages that have no sample of their own: front and back
 * matter with the language's titles, chapter titles with number words, formal
 * and informal address, the language's quotation marks, and names in the forms
 * the language gives them ("u brány Černé věže", "rycerze Zakonu").
 */
export interface SampleNovel {
  title: string;
  contents: string;
  chapters: [title: string, paragraphs: string[]][];
  back: [title: string, paragraph: string];
  /** Names in their base form that the first chapter mentions, some only inflected. */
  names: string[];
}

export const SAMPLE_NOVELS: Record<string, SampleNovel> = {
  es: {
    title: "La Torre Negra",
    contents: "Índice",
    chapters: [
      [
        "Capítulo primero",
        [
          "Ana esperaba ante la puerta de la Torre Negra hasta que volvieran los caballeros de la Orden.",
          "«Pase usted», le dijo el capitán, «la Orden ya la espera».",
          "Jonás, el hermano de Ana, estaba detrás de él y callaba.",
          "Desde el invierno nadie había subido a la Torre Negra.",
        ],
      ],
      [
        "Capítulo segundo",
        [
          "«Así que lo has encontrado», susurró Jonás cuando se quedaron solos.",
          "Ana asintió y le mostró el sello de la Orden.",
          "El capitán no debía saber nada de ello.",
        ],
      ],
    ],
    back: ["Agradecimientos", "Doy las gracias a todos los que han hecho posible este libro."],
    names: ["Orden", "Torre Negra", "Ana"],
  },
  pt: {
    title: "A Torre Negra",
    contents: "Sumário",
    chapters: [
      [
        "Capítulo primeiro",
        [
          "Ana esperava junto ao portão da Torre Negra até que os cavaleiros da Ordem regressassem.",
          "«Entre, por favor», disse-lhe o capitão, «a Ordem já a espera.»",
          "Jonas, o irmão de Ana, estava atrás dele e calava-se.",
          "Desde o inverno ninguém subira à Torre Negra.",
        ],
      ],
      [
        "Capítulo segundo",
        [
          "«Então encontraste-o», sussurrou Jonas quando ficaram sozinhos.",
          "Ana acenou com a cabeça e mostrou-lhe o selo da Ordem.",
          "O capitão não podia saber nada disso.",
        ],
      ],
    ],
    back: ["Agradecimentos", "Agradeço a todos os que tornaram este livro possível."],
    names: ["Ordem", "Torre Negra", "Ana"],
  },
  it: {
    title: "La Torre Nera",
    contents: "Indice",
    chapters: [
      [
        "Capitolo primo",
        [
          "Anna aspettava davanti al portone della Torre Nera, finché i cavalieri dell’Ordine non fossero tornati.",
          "«Entri pure», le disse il capitano, «l’Ordine la sta già aspettando.»",
          "Giona, il fratello di Anna, stava dietro di lui e taceva.",
          "Dall’inverno nessuno era più salito alla Torre Nera.",
        ],
      ],
      [
        "Capitolo secondo",
        [
          "«Allora l’hai trovato», sussurrò Giona quando rimasero soli.",
          "Anna annuì e gli mostrò il sigillo dell’Ordine.",
          "Il capitano non doveva saperne nulla.",
        ],
      ],
    ],
    back: ["Ringraziamenti", "Ringrazio tutti coloro che hanno reso possibile questo libro."],
    names: ["Ordine", "Torre Nera", "Anna"],
  },
  fr: {
    title: "La Tour noire",
    contents: "Table des matières",
    chapters: [
      [
        "Chapitre premier",
        [
          "Anna attendait devant la porte de la Tour noire que les chevaliers de l’Ordre reviennent.",
          "« Entrez donc », lui dit le capitaine, « l’Ordre vous attend déjà. »",
          "Jonas, le frère d’Anna, se tenait derrière lui et se taisait.",
          "Depuis l’hiver, personne n’était monté jusqu’à la Tour noire.",
        ],
      ],
      [
        "Chapitre deux",
        [
          "« Alors tu l’as trouvé », chuchota Jonas quand ils furent seuls.",
          "Anna hocha la tête et lui montra le sceau de l’Ordre.",
          "Le capitaine ne devait rien en savoir.",
        ],
      ],
    ],
    back: ["Remerciements", "Je remercie tous ceux qui ont rendu ce livre possible."],
    names: ["Ordre", "Tour noire", "Anna"],
  },
  ca: {
    title: "La Torre Negra",
    contents: "Índex",
    chapters: [
      [
        "Capítol primer",
        [
          "L’Anna esperava davant la porta de la Torre Negra fins que tornessin els cavallers de l’Orde.",
          "«Passi, si us plau», li va dir el capità, «l’Orde ja l’espera».",
          "En Jonàs, el germà de l’Anna, era darrere seu i callava.",
          "Des de l’hivern ningú no havia pujat a la Torre Negra.",
        ],
      ],
      [
        "Capítol segon",
        [
          "«Així que l’has trobat», va xiuxiuejar en Jonàs quan es van quedar sols.",
          "L’Anna va assentir i li va ensenyar el segell de l’Orde.",
          "El capità no n’havia de saber res.",
        ],
      ],
    ],
    back: ["Agraïments", "Dono les gràcies a tothom qui ha fet possible aquest llibre."],
    names: ["Orde", "Torre Negra", "Anna"],
  },
  ro: {
    title: "Turnul Negru",
    contents: "Cuprins",
    chapters: [
      [
        "Capitolul întâi",
        [
          "Ana aștepta la poarta Turnului Negru până când cavalerii Ordinului aveau să se întoarcă.",
          "„Intrați, vă rog”, i-a spus căpitanul, „Ordinul vă așteaptă deja.”",
          "Fratele Anei, Ionuț, stătea în spatele lui și tăcea.",
          "Din iarnă nimeni nu mai urcase la Turnul Negru.",
        ],
      ],
      [
        "Capitolul al doilea",
        [
          "„Deci l-ai găsit”, a șoptit Ionuț când au rămas singuri.",
          "Ana a dat din cap și i-a arătat sigiliul Ordinului.",
          "Căpitanul nu trebuia să afle nimic despre asta.",
        ],
      ],
    ],
    back: ["Mulțumiri", "Le mulțumesc tuturor celor care au făcut posibilă această carte."],
    names: ["Ordin", "Turn Negru", "Ana"],
  },
  nl: {
    title: "De Zwarte Toren",
    contents: "Inhoudsopgave",
    chapters: [
      [
        "Eerste hoofdstuk",
        [
          "Anna wachtte bij de poort van de Zwarte Toren tot de ridders van de Orde terugkeerden.",
          "‘Komt u binnen,’ zei de kapitein tegen haar, ‘de Orde wacht al op u.’",
          "Anna’s broer Jonas stond achter hem en zweeg.",
          "Sinds de winter was niemand meer naar de Zwarte Toren geklommen.",
        ],
      ],
      [
        "Tweede hoofdstuk",
        [
          "‘Dus je hebt het gevonden,’ fluisterde Jonas toen ze alleen waren.",
          "Anna knikte en liet hem het zegel van de Orde zien.",
          "De kapitein mocht er niets van weten.",
        ],
      ],
    ],
    back: ["Dankwoord", "Ik dank iedereen die dit boek mogelijk heeft gemaakt."],
    names: ["Orde", "Zwarte Toren", "Anna"],
  },
  sv: {
    title: "Svarta tornet",
    contents: "Innehåll",
    chapters: [
      [
        "Första kapitlet",
        [
          "Anna väntade vid porten till Svarta tornet tills Ordens riddare kom tillbaka.",
          "”Stig på”, sade kaptenen till henne, ”Orden väntar redan på er.”",
          "Annas bror Jonas stod bakom honom och teg.",
          "Sedan vintern hade ingen gått upp till Svarta tornet.",
        ],
      ],
      [
        "Andra kapitlet",
        [
          "”Så du har hittat den”, viskade Jonas när de var ensamma.",
          "Anna nickade och visade honom Ordens sigill.",
          "Kaptenen fick inte veta något om det.",
        ],
      ],
    ],
    back: ["Tack", "Jag tackar alla som har gjort den här boken möjlig."],
    names: ["Orden", "Svarta tornet", "Anna"],
  },
  da: {
    title: "Det Sorte Tårn",
    contents: "Indhold",
    chapters: [
      [
        "Første kapitel",
        [
          "Anna ventede ved porten til Det Sorte Tårn, til Ordenens riddere kom tilbage.",
          "»Kom indenfor,« sagde kaptajnen til hende, »Ordenen venter allerede på Dem.«",
          "Annas bror Jonas stod bag ham og tav.",
          "Siden vinteren var ingen gået op til Det Sorte Tårn.",
        ],
      ],
      [
        "Andet kapitel",
        [
          "»Så du har fundet det,« hviskede Jonas, da de var alene.",
          "Anna nikkede og viste ham Ordenens segl.",
          "Kaptajnen måtte intet vide om det.",
        ],
      ],
    ],
    back: ["Tak", "Jeg takker alle, der har gjort denne bog mulig."],
    names: ["Orden", "Sorte Tårn", "Anna"],
  },
  nb: {
    title: "Det svarte tårnet",
    contents: "Innhold",
    chapters: [
      [
        "Første kapittel",
        [
          "Anna ventet ved porten til Det svarte tårnet til Ordenens riddere kom tilbake.",
          "«Kom inn,» sa kapteinen til henne, «Ordenen venter allerede på Dem.»",
          "Annas bror Jonas sto bak ham og tidde.",
          "Siden vinteren hadde ingen gått opp til Det svarte tårnet.",
        ],
      ],
      [
        "Andre kapittel",
        [
          "«Så du har funnet det,» hvisket Jonas da de var alene.",
          "Anna nikket og viste ham Ordenens segl.",
          "Kapteinen måtte ikke få vite noe om det.",
        ],
      ],
    ],
    back: ["Takk", "Jeg takker alle som har gjort denne boken mulig."],
    names: ["Orden", "svarte tårnet", "Anna"],
  },
  cs: {
    title: "Černá věž",
    contents: "Obsah",
    chapters: [
      [
        "Kapitola první",
        [
          "Anna čekala u brány Černé věže, dokud se rytíři Řádu nevrátili.",
          "„Pojďte dál,“ řekl jí kapitán, „Řád už na vás čeká.“",
          "Annin bratr Jonáš stál za ním a mlčel.",
          "Od zimy nikdo nevystoupal k Černé věži.",
        ],
      ],
      [
        "Kapitola druhá",
        [
          "„Tak tys to našla,“ zašeptal Jonáš, když byli sami.",
          "Anna přikývla a ukázala mu pečeť Řádu.",
          "Kapitán se o tom nesměl nic dozvědět.",
        ],
      ],
    ],
    back: ["Poděkování", "Děkuji všem, kteří tuto knihu umožnili."],
    names: ["Řád", "Černá věž", "Anna"],
  },
  sk: {
    title: "Čierna veža",
    contents: "Obsah",
    chapters: [
      [
        "Kapitola prvá",
        [
          "Anna čakala pri bráne Čiernej veže, kým sa rytieri Rádu nevrátili.",
          "„Poďte ďalej,“ povedal jej kapitán, „Rád už na vás čaká.“",
          "Annin brat Jonáš stál za ním a mlčal.",
          "Od zimy nikto nevystúpil k Čiernej veži.",
        ],
      ],
      [
        "Kapitola druhá",
        [
          "„Tak si to našla,“ zašepkal Jonáš, keď boli sami.",
          "Anna prikývla a ukázala mu pečať Rádu.",
          "Kapitán sa o tom nesmel nič dozvedieť.",
        ],
      ],
    ],
    back: ["Poďakovanie", "Ďakujem všetkým, ktorí túto knihu umožnili."],
    names: ["Rád", "Čierna veža", "Anna"],
  },
  hr: {
    title: "Crna kula",
    contents: "Sadržaj",
    chapters: [
      [
        "Poglavlje prvo",
        [
          "Ana je čekala pred vratima Crne kule dok se vitezovi Reda nisu vratili.",
          "„Uđite“, rekao joj je kapetan, „Red vas već čeka.“",
          "Anin brat Jona stajao je iza njega i šutio.",
          "Od zime se nitko nije popeo do Crne kule.",
        ],
      ],
      [
        "Poglavlje drugo",
        [
          "„Dakle, našla si ga“, šapnuo je Jona kad su ostali sami.",
          "Ana je kimnula i pokazala mu pečat Reda.",
          "Kapetan o tome nije smio ništa saznati.",
        ],
      ],
    ],
    back: ["Zahvale", "Zahvaljujem svima koji su omogućili ovu knjigu."],
    names: ["Red", "Crna kula", "Ana"],
  },
  sl: {
    title: "Črni stolp",
    contents: "Kazalo",
    chapters: [
      [
        "Poglavje prvo",
        [
          "Ana je čakala pred vrati Črnega stolpa, dokler se vitezi Reda niso vrnili.",
          "»Vstopite,« ji je rekel kapitan, »Red vas že čaka.«",
          "Anin brat Jona je stal za njim in molčal.",
          "Od zime se nihče ni povzpel do Črnega stolpa.",
        ],
      ],
      [
        "Poglavje drugo",
        [
          "»Torej si ga našla,« je zašepetal Jona, ko sta ostala sama.",
          "Ana je prikimala in mu pokazala pečat Reda.",
          "Kapitan o tem ni smel ničesar izvedeti.",
        ],
      ],
    ],
    back: ["Zahvala", "Zahvaljujem se vsem, ki so omogočili to knjigo."],
    names: ["Red", "Črni stolp", "Ana"],
  },
  sr: {
    title: "Црна кула",
    contents: "Садржај",
    chapters: [
      [
        "Глава прва",
        [
          "Ана је чекала пред вратима Црне куле док се витезови Реда нису вратили.",
          "„Уђите“, рекао јој је капетан, „Ред вас већ чека.“",
          "Анин брат Јона стајао је иза њега и ћутао.",
          "Од зиме се нико није попео до Црне куле.",
        ],
      ],
      [
        "Глава друга",
        [
          "„Дакле, нашла си га“, шапнуо је Јона кад су остали сами.",
          "Ана је климнула и показала му печат Реда.",
          "Капетан о томе није смео ништа да сазна.",
        ],
      ],
    ],
    back: ["Захвалност", "Захваљујем свима који су омогућили ову књигу."],
    names: ["Ред", "Црна кула", "Ана"],
  },
  uk: {
    title: "Чорна вежа",
    contents: "Зміст",
    chapters: [
      [
        "Розділ перший",
        [
          "Анна чекала біля брами Чорної вежі, доки не повернулися лицарі Ордену.",
          "«Заходьте, — сказав їй капітан, — Орден уже чекає на вас».",
          "Брат Анни, Йона, стояв позаду нього й мовчав.",
          "Від зими ніхто не підіймався до Чорної вежі.",
        ],
      ],
      [
        "Розділ другий",
        [
          "«Отже, ти його знайшла», — прошепотів Йона, коли вони залишилися самі.",
          "Анна кивнула й показала йому печатку Ордену.",
          "Капітан не мав нічого про це дізнатися.",
        ],
      ],
    ],
    back: ["Подяки", "Дякую всім, хто допоміг цій книжці з’явитися."],
    names: ["Орден", "Чорна вежа", "Анна"],
  },
  bg: {
    title: "Черната кула",
    contents: "Съдържание",
    chapters: [
      [
        "Глава първа",
        [
          "Ана чакаше пред портата на Черната кула, докато рицарите на Ордена се върнат.",
          "„Влезте“, каза ѝ капитанът, „Орденът вече ви чака.“",
          "Братът на Ана, Йона, стоеше зад него и мълчеше.",
          "От зимата никой не се беше качвал до Черната кула.",
        ],
      ],
      [
        "Глава втора",
        [
          "„Значи си го намерила“, прошепна Йона, когато останаха сами.",
          "Ана кимна и му показа печата на Ордена.",
          "Капитанът не трябваше да научи нищо за това.",
        ],
      ],
    ],
    back: ["Благодарности", "Благодаря на всички, които направиха тази книга възможна."],
    names: ["Орден", "Черна кула", "Ана"],
  },
  el: {
    title: "Ο Μαύρος Πύργος",
    contents: "Περιεχόμενα",
    chapters: [
      [
        "Κεφάλαιο πρώτο",
        [
          "Η Άννα περίμενε στην πύλη του Μαύρου Πύργου ώσπου να γυρίσουν οι ιππότες του Τάγματος.",
          "«Περάστε», της είπε ο λοχαγός, «το Τάγμα σάς περιμένει ήδη.»",
          "Ο αδελφός της Άννας, ο Ιωνάς, στεκόταν πίσω του και σώπαινε.",
          "Από τον χειμώνα κανείς δεν είχε ανέβει στον Μαύρο Πύργο.",
        ],
      ],
      [
        "Κεφάλαιο δεύτερο",
        [
          "«Ώστε το βρήκες», ψιθύρισε ο Ιωνάς όταν έμειναν μόνοι.",
          "Η Άννα έγνεψε και του έδειξε τη σφραγίδα του Τάγματος.",
          "Ο λοχαγός δεν έπρεπε να μάθει τίποτα γι’ αυτό.",
        ],
      ],
    ],
    back: ["Ευχαριστίες", "Ευχαριστώ όλους όσοι έκαναν αυτό το βιβλίο δυνατό."],
    names: ["Τάγμα", "Μαύρος Πύργος", "Άννα"],
  },
  id: {
    title: "Menara Hitam",
    contents: "Daftar Isi",
    chapters: [
      [
        "Bab Satu",
        [
          "Anna menunggu di gerbang Menara Hitam sampai para ksatria Ordo kembali.",
          "“Silakan masuk,” kata kapten kepadanya, “Ordo sudah menunggu Anda.”",
          "Kakak Anna, Yunus, berdiri di belakangnya dan diam saja.",
          "Sejak musim dingin tidak ada yang naik ke Menara Hitam.",
        ],
      ],
      [
        "Bab Dua",
        [
          "“Jadi kau menemukannya,” bisik Yunus ketika mereka sendirian.",
          "Anna mengangguk dan menunjukkan segel Ordo kepadanya.",
          "Kapten tidak boleh tahu apa pun tentang hal itu.",
        ],
      ],
    ],
    back: ["Ucapan Terima Kasih", "Terima kasih kepada semua yang telah membuat buku ini mungkin."],
    names: ["Ordo", "Menara Hitam", "Anna"],
  },
  ms: {
    title: "Menara Hitam",
    contents: "Kandungan",
    chapters: [
      [
        "Bab Satu",
        [
          "Anna menunggu di pintu gerbang Menara Hitam sehingga para kesatria Ordo kembali.",
          "“Sila masuk,” kata kapten kepadanya, “Ordo sudah menanti cik.”",
          "Abang Anna, Yunus, berdiri di belakangnya dan berdiam diri.",
          "Sejak musim sejuk tiada sesiapa yang naik ke Menara Hitam.",
        ],
      ],
      [
        "Bab Dua",
        [
          "“Jadi kau sudah menjumpainya,” bisik Yunus apabila mereka berdua sahaja.",
          "Anna mengangguk dan menunjukkan mohor Ordo kepadanya.",
          "Kapten tidak boleh tahu apa-apa tentang hal itu.",
        ],
      ],
    ],
    back: ["Penghargaan", "Terima kasih kepada semua yang telah menjadikan buku ini mungkin."],
    names: ["Ordo", "Menara Hitam", "Anna"],
  },
  fil: {
    title: "Ang Itim na Tore",
    contents: "Talaan ng Nilalaman",
    chapters: [
      [
        "Unang Kabanata",
        [
          "Naghintay si Anna sa tarangkahan ng Itim na Tore hanggang sa makabalik ang mga kabalyero ng Orden.",
          "“Pumasok po kayo,” sabi sa kanya ng kapitan, “hinihintay na kayo ng Orden.”",
          "Nakatayo sa likod niya ang kapatid ni Anna na si Jonas at tahimik lamang.",
          "Mula noong taglamig, wala nang umakyat sa Itim na Tore.",
        ],
      ],
      [
        "Ikalawang Kabanata",
        [
          "“Kaya nahanap mo pala,” bulong ni Jonas nang sila na lamang dalawa.",
          "Tumango si Anna at ipinakita sa kanya ang selyo ng Orden.",
          "Hindi dapat malaman ng kapitan ang anumang tungkol dito.",
        ],
      ],
    ],
    back: [
      "Pasasalamat",
      "Nagpapasalamat ako sa lahat ng tumulong upang maging posible ang aklat na ito.",
    ],
    names: ["Orden", "Itim na Tore", "Anna"],
  },
};

/** The sample novel in a language of SAMPLE_NOVELS, as an EPUB. */
export function sampleNovelIn(tag: string): Uint8Array {
  const novel = SAMPLE_NOVELS[tag];
  if (!novel) throw new Error(`No sample novel in "${tag}".`);
  const doc = (path: string, title: string, paragraphs: string[]) => ({
    path,
    title,
    body: `<h1>${title}</h1>\n${paragraphs.map((p) => `<p>${p}</p>`).join("\n")}`,
  });
  const docs = [
    doc(
      "text/contents.xhtml",
      novel.contents,
      novel.chapters.map(([title]) => title),
    ),
    ...novel.chapters.map(([title, paragraphs], i) =>
      doc(`text/c${i + 1}.xhtml`, title, paragraphs),
    ),
    doc("text/back.xhtml", novel.back[0], [novel.back[1]]),
  ];
  const hex = [...tag].map((c) => c.charCodeAt(0).toString(16)).join("");
  return buildFixtureEpub({
    language: tag,
    title: novel.title,
    identifier: `urn:uuid:dddddddd-1234-4234-8234-${hex.padEnd(12, "0").slice(0, 12)}`,
    docs,
    toc: docs.map((d) => ({ title: d.title, href: d.path })),
  });
}
