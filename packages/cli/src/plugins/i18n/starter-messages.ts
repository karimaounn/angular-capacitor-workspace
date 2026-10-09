/**
 * The starter strings the generated catalogs hold, in every language the
 * generator can write them in.
 *
 * Without these, every catalog but the source one is a tagged copy of it, and
 * switching language on a new workspace changes `Translation` into
 * `[fr] Translation`, which reads as a switch that does not work. These are
 * the languages `create` offers by name; any other gets the tagged copy, as
 * before, and a language added to the config later gets these where the source
 * catalog still holds the starter text.
 *
 * Starter content, like the screens that read it: written once into a catalog
 * that is then the workspace's, never updated in place. Keys follow the
 * catalog templates, and `{name}` slots are filled at runtime. `%title%` is
 * the app's name, filled in at generation.
 *
 * Plural keys list the CLDR categories each language selects, not English's:
 * Arabic carries all six, Hebrew adds `two`, and Japanese, Korean and Chinese
 * have only `other`. A category left out falls back to `other` at runtime.
 */
export type Messages = Readonly<Record<string, string>>;

const en: Messages = {
  'language.label': 'Language',

  'showcase.heading': 'Translation',
  'showcase.intro': 'Every string below is looked up at runtime.',
  'showcase.active': 'Active: {locale}, written {direction}.',
  'showcase.plain.label': 'Plain key',
  'showcase.plain.value': 'Nothing to substitute here.',
  'showcase.interpolated.label': 'Placeholder',
  'showcase.greeting': 'Hello, {name}!',
  'showcase.plural.label': 'Plural',
  'showcase.items.one': '{count} item in the basket',
  'showcase.items.other': '{count} items in the basket',
  'showcase.fewer': 'One fewer',
  'showcase.more': 'One more',
  'showcase.number.label': 'Number',
  'showcase.currency.label': 'Currency',
  'showcase.date.label': 'Date',
  'showcase.relative.label': 'Relative time',
  'showcase.direction.label': 'Direction',
  'showcase.direction.ltr': 'Left to right',
  'showcase.direction.rtl': 'Right to left',
  'showcase.footnote':
    'Numbers and dates go through TranslationService, not DatePipe or DecimalPipe: ' +
    'those read the build-time LOCALE_ID and cannot follow a runtime switch.',

  'seo.home.description':
    '%title%: replace this with a sentence or two about the site. ' +
    'It is what search results show under the title.',
  'seo.notFound.title': 'Page not found',
  'seo.notFound.description': 'There is no page at this address. The link may be out of date.',
  'site.languages': 'Languages',
  'site.prerendered':
    'This page is prerendered once per language. The links above are real URLs, ' +
    'so a crawler indexes each language separately.',

  'starter.lead':
    "Everything below is drawn from the design system's tokens, which declare light " +
    "and dark in one stylesheet. Switch your system's colour scheme and the whole " +
    'page follows without a re-render.',
  'starter.tokensHeading': 'Tokens',
  'starter.tokensNote':
    'Every pairing above meets WCAG contrast in both modes and every palette. The check:',
  'starter.componentsHeading': 'Components',
  'starter.primary': 'Primary',
  'starter.secondary': 'Secondary',
  'starter.ghost': 'Ghost',
  'starter.danger': 'Danger',
  'starter.disabled': 'Disabled',
  'starter.emailLabel': 'Email address',
  'starter.emailHint': 'Type something without an @ to see the error state.',
  'starter.emailError': 'That does not look like an email address.',
  'starter.componentsSource': 'Their source:',
  'starter.componentsStories': 'Their stories, in Storybook:',
  'starter.nextHeading': 'Next',
  'starter.nextReplace': 'Replace this page:',
  'starter.nextRules': 'House rules for this workspace:',
  'starter.nextScripts': 'Every script, with a line on each:',
  'starter.nextPalette': 'Add a palette:',
};

const es: Messages = {
  'language.label': 'Idioma',

  'showcase.heading': 'Traducción',
  'showcase.intro': 'Cada texto de abajo se busca en tiempo de ejecución.',
  'showcase.active': 'Activo: {locale}, escrito {direction}.',
  'showcase.plain.label': 'Clave simple',
  'showcase.plain.value': 'Aquí no hay nada que sustituir.',
  'showcase.interpolated.label': 'Marcador',
  'showcase.greeting': '¡Hola, {name}!',
  'showcase.plural.label': 'Plural',
  'showcase.items.one': '{count} artículo en la cesta',
  'showcase.items.other': '{count} artículos en la cesta',
  'showcase.fewer': 'Uno menos',
  'showcase.more': 'Uno más',
  'showcase.number.label': 'Número',
  'showcase.currency.label': 'Moneda',
  'showcase.date.label': 'Fecha',
  'showcase.relative.label': 'Tiempo relativo',
  'showcase.direction.label': 'Dirección',
  'showcase.direction.ltr': 'De izquierda a derecha',
  'showcase.direction.rtl': 'De derecha a izquierda',
  'showcase.footnote':
    'Los números y las fechas pasan por TranslationService, no por DatePipe ni DecimalPipe: ' +
    'estos leen el LOCALE_ID fijado al compilar y no pueden seguir un cambio en tiempo de ejecución.',

  'seo.home.description':
    '%title%: sustituye esto por una o dos frases sobre el sitio. ' +
    'Es lo que muestran los resultados de búsqueda bajo el título.',
  'seo.notFound.title': 'Página no encontrada',
  'seo.notFound.description':
    'No hay ninguna página en esta dirección. Puede que el enlace esté desactualizado.',
  'site.languages': 'Idiomas',
  'site.prerendered':
    'Esta página se prerrenderiza una vez por idioma. Los enlaces de arriba son URL reales, ' +
    'así que un rastreador indexa cada idioma por separado.',

  'starter.lead':
    'Todo lo de abajo sale de los tokens del sistema de diseño, que declaran el modo claro ' +
    'y el oscuro en una sola hoja de estilos. Cambia el esquema de color de tu sistema y ' +
    'toda la página lo sigue sin volver a renderizarse.',
  'starter.tokensHeading': 'Tokens',
  'starter.tokensNote':
    'Cada combinación de arriba cumple el contraste WCAG en ambos modos y en cada paleta. La comprobación:',
  'starter.componentsHeading': 'Componentes',
  'starter.primary': 'Principal',
  'starter.secondary': 'Secundario',
  'starter.ghost': 'Fantasma',
  'starter.danger': 'Peligro',
  'starter.disabled': 'Desactivado',
  'starter.emailLabel': 'Correo electrónico',
  'starter.emailHint': 'Escribe algo sin @ para ver el estado de error.',
  'starter.emailError': 'Eso no parece una dirección de correo electrónico.',
  'starter.componentsSource': 'Su código:',
  'starter.componentsStories': 'Sus historias, en Storybook:',
  'starter.nextHeading': 'Siguientes pasos',
  'starter.nextReplace': 'Sustituye esta página:',
  'starter.nextRules': 'Las normas de este workspace:',
  'starter.nextScripts': 'Cada script, con una línea sobre cada uno:',
  'starter.nextPalette': 'Añade una paleta:',
};

const fr: Messages = {
  'language.label': 'Langue',

  'showcase.heading': 'Traduction',
  'showcase.intro': "Chaque texte ci-dessous est recherché à l'exécution.",
  'showcase.active': 'Actif : {locale}, écrit {direction}.',
  'showcase.plain.label': 'Clé simple',
  'showcase.plain.value': 'Rien à substituer ici.',
  'showcase.interpolated.label': 'Paramètre',
  'showcase.greeting': 'Bonjour, {name} !',
  'showcase.plural.label': 'Pluriel',
  // French puts 0 in `one`: « 0 article ».
  'showcase.items.one': '{count} article dans le panier',
  'showcase.items.other': '{count} articles dans le panier',
  'showcase.fewer': 'Un de moins',
  'showcase.more': 'Un de plus',
  'showcase.number.label': 'Nombre',
  'showcase.currency.label': 'Devise',
  'showcase.date.label': 'Date',
  'showcase.relative.label': 'Temps relatif',
  'showcase.direction.label': "Sens d'écriture",
  'showcase.direction.ltr': 'De gauche à droite',
  'showcase.direction.rtl': 'De droite à gauche',
  'showcase.footnote':
    'Les nombres et les dates passent par TranslationService, pas par DatePipe ni DecimalPipe : ' +
    "ceux-ci lisent le LOCALE_ID fixé à la compilation et ne peuvent pas suivre un changement à l'exécution.",

  'seo.home.description':
    '%title% : remplacez ceci par une phrase ou deux sur le site. ' +
    "C'est ce que les résultats de recherche affichent sous le titre.",
  'seo.notFound.title': 'Page introuvable',
  'seo.notFound.description':
    "Il n'y a aucune page à cette adresse. Le lien est peut-être obsolète.",
  'site.languages': 'Langues',
  'site.prerendered':
    'Cette page est prérendue une fois par langue. Les liens ci-dessus sont de vraies URL, ' +
    "donc un robot d'indexation indexe chaque langue séparément.",

  'starter.lead':
    'Tout ce qui suit est tiré des jetons du design system, qui déclarent le clair et le ' +
    'sombre dans une seule feuille de style. Changez le thème de couleurs de votre système ' +
    'et toute la page suit, sans nouveau rendu.',
  'starter.tokensHeading': 'Jetons',
  'starter.tokensNote':
    'Chaque association ci-dessus respecte le contraste WCAG dans les deux modes et pour chaque palette. La vérification :',
  'starter.componentsHeading': 'Composants',
  'starter.primary': 'Principal',
  'starter.secondary': 'Secondaire',
  'starter.ghost': 'Discret',
  'starter.danger': 'Danger',
  'starter.disabled': 'Désactivé',
  'starter.emailLabel': 'Adresse e-mail',
  'starter.emailHint': "Tapez quelque chose sans @ pour voir l'état d'erreur.",
  'starter.emailError': 'Cela ne ressemble pas à une adresse e-mail.',
  'starter.componentsSource': 'Leur code source :',
  'starter.componentsStories': 'Leurs stories, dans Storybook :',
  'starter.nextHeading': 'Et ensuite',
  'starter.nextReplace': 'Remplacez cette page :',
  'starter.nextRules': 'Les règles de ce workspace :',
  'starter.nextScripts': 'Chaque script, avec une ligne sur chacun :',
  'starter.nextPalette': 'Ajoutez une palette :',
};

const de: Messages = {
  'language.label': 'Sprache',

  'showcase.heading': 'Übersetzung',
  'showcase.intro': 'Jeder Text unten wird zur Laufzeit nachgeschlagen.',
  'showcase.active': 'Aktiv: {locale}, Schreibrichtung {direction}.',
  'showcase.plain.label': 'Einfacher Schlüssel',
  'showcase.plain.value': 'Hier gibt es nichts zu ersetzen.',
  'showcase.interpolated.label': 'Platzhalter',
  'showcase.greeting': 'Hallo, {name}!',
  'showcase.plural.label': 'Plural',
  'showcase.items.one': '{count} Artikel im Warenkorb',
  'showcase.items.other': '{count} Artikel im Warenkorb',
  'showcase.fewer': 'Einer weniger',
  'showcase.more': 'Einer mehr',
  'showcase.number.label': 'Zahl',
  'showcase.currency.label': 'Währung',
  'showcase.date.label': 'Datum',
  'showcase.relative.label': 'Relative Zeit',
  'showcase.direction.label': 'Schreibrichtung',
  'showcase.direction.ltr': 'Von links nach rechts',
  'showcase.direction.rtl': 'Von rechts nach links',
  'showcase.footnote':
    'Zahlen und Daten laufen über TranslationService, nicht über DatePipe oder DecimalPipe: ' +
    'Diese lesen die beim Build festgelegte LOCALE_ID und können einem Wechsel zur Laufzeit nicht folgen.',

  'seo.home.description':
    '%title%: Ersetzen Sie dies durch ein, zwei Sätze über die Website. ' +
    'Suchergebnisse zeigen ihn unter dem Titel.',
  'seo.notFound.title': 'Seite nicht gefunden',
  'seo.notFound.description':
    'Unter dieser Adresse gibt es keine Seite. Der Link ist möglicherweise veraltet.',
  'site.languages': 'Sprachen',
  'site.prerendered':
    'Diese Seite wird einmal pro Sprache vorgerendert. Die Links oben sind echte URLs, ' +
    'daher indexiert ein Crawler jede Sprache einzeln.',

  'starter.lead':
    'Alles unten stammt aus den Tokens des Designsystems, die Hell und Dunkel in einem ' +
    'Stylesheet festlegen. Stellen Sie das Farbschema Ihres Systems um, und die ganze ' +
    'Seite folgt ohne erneutes Rendern.',
  'starter.tokensHeading': 'Tokens',
  'starter.tokensNote':
    'Jede Kombination oben erfüllt den WCAG-Kontrast in beiden Modi und jeder Palette. Die Prüfung:',
  'starter.componentsHeading': 'Komponenten',
  'starter.primary': 'Primär',
  'starter.secondary': 'Sekundär',
  'starter.ghost': 'Dezent',
  'starter.danger': 'Gefahr',
  'starter.disabled': 'Deaktiviert',
  'starter.emailLabel': 'E-Mail-Adresse',
  'starter.emailHint': 'Geben Sie etwas ohne @ ein, um den Fehlerzustand zu sehen.',
  'starter.emailError': 'Das sieht nicht nach einer E-Mail-Adresse aus.',
  'starter.componentsSource': 'Ihr Quellcode:',
  'starter.componentsStories': 'Ihre Stories, in Storybook:',
  'starter.nextHeading': 'Als Nächstes',
  'starter.nextReplace': 'Diese Seite ersetzen:',
  'starter.nextRules': 'Die Regeln dieses Workspace:',
  'starter.nextScripts': 'Jedes Skript, mit einer Zeile zu jedem:',
  'starter.nextPalette': 'Eine Palette hinzufügen:',
};

const it: Messages = {
  'language.label': 'Lingua',

  'showcase.heading': 'Traduzione',
  'showcase.intro': 'Ogni testo qui sotto viene cercato in fase di esecuzione.',
  'showcase.active': 'Attiva: {locale}, scritta {direction}.',
  'showcase.plain.label': 'Chiave semplice',
  'showcase.plain.value': 'Niente da sostituire qui.',
  'showcase.interpolated.label': 'Segnaposto',
  'showcase.greeting': 'Ciao, {name}!',
  'showcase.plural.label': 'Plurale',
  'showcase.items.one': '{count} articolo nel carrello',
  'showcase.items.other': '{count} articoli nel carrello',
  'showcase.fewer': 'Uno in meno',
  'showcase.more': 'Uno in più',
  'showcase.number.label': 'Numero',
  'showcase.currency.label': 'Valuta',
  'showcase.date.label': 'Data',
  'showcase.relative.label': 'Tempo relativo',
  'showcase.direction.label': 'Direzione',
  'showcase.direction.ltr': 'Da sinistra a destra',
  'showcase.direction.rtl': 'Da destra a sinistra',
  'showcase.footnote':
    'Numeri e date passano da TranslationService, non da DatePipe o DecimalPipe: ' +
    'quelli leggono il LOCALE_ID fissato in compilazione e non possono seguire un cambio in esecuzione.',

  'seo.home.description':
    '%title%: sostituisci questo testo con una o due frasi sul sito. ' +
    'È ciò che i risultati di ricerca mostrano sotto il titolo.',
  'seo.notFound.title': 'Pagina non trovata',
  'seo.notFound.description':
    'Non esiste alcuna pagina a questo indirizzo. Il link potrebbe essere obsoleto.',
  'site.languages': 'Lingue',
  'site.prerendered':
    'Questa pagina è prerenderizzata una volta per lingua. I link qui sopra sono URL reali, ' +
    'quindi un crawler indicizza ogni lingua separatamente.',

  'starter.lead':
    'Tutto ciò che segue proviene dai token del design system, che dichiarano chiaro e ' +
    'scuro in un unico foglio di stile. Cambia lo schema di colori del sistema e tutta la ' +
    'pagina lo segue senza un nuovo rendering.',
  'starter.tokensHeading': 'Token',
  'starter.tokensNote':
    'Ogni abbinamento qui sopra rispetta il contrasto WCAG in entrambe le modalità e in ogni palette. Il controllo:',
  'starter.componentsHeading': 'Componenti',
  'starter.primary': 'Principale',
  'starter.secondary': 'Secondario',
  'starter.ghost': 'Discreto',
  'starter.danger': 'Pericolo',
  'starter.disabled': 'Disattivato',
  'starter.emailLabel': 'Indirizzo email',
  'starter.emailHint': 'Scrivi qualcosa senza @ per vedere lo stato di errore.',
  'starter.emailError': 'Non sembra un indirizzo email.',
  'starter.componentsSource': 'Il loro codice:',
  'starter.componentsStories': 'Le loro storie, in Storybook:',
  'starter.nextHeading': 'Prossimi passi',
  'starter.nextReplace': 'Sostituisci questa pagina:',
  'starter.nextRules': 'Le regole di questo workspace:',
  'starter.nextScripts': 'Ogni script, con una riga su ciascuno:',
  'starter.nextPalette': 'Aggiungi una palette:',
};

const pt: Messages = {
  'language.label': 'Idioma',

  'showcase.heading': 'Tradução',
  'showcase.intro': 'Cada texto abaixo é procurado em tempo de execução.',
  'showcase.active': 'Ativo: {locale}, escrito {direction}.',
  'showcase.plain.label': 'Chave simples',
  'showcase.plain.value': 'Nada para substituir aqui.',
  'showcase.interpolated.label': 'Marcador',
  'showcase.greeting': 'Olá, {name}!',
  'showcase.plural.label': 'Plural',
  'showcase.items.one': '{count} item na cesta',
  'showcase.items.other': '{count} itens na cesta',
  'showcase.fewer': 'Um a menos',
  'showcase.more': 'Um a mais',
  'showcase.number.label': 'Número',
  'showcase.currency.label': 'Moeda',
  'showcase.date.label': 'Data',
  'showcase.relative.label': 'Tempo relativo',
  'showcase.direction.label': 'Direção',
  'showcase.direction.ltr': 'Da esquerda para a direita',
  'showcase.direction.rtl': 'Da direita para a esquerda',
  'showcase.footnote':
    'Números e datas passam pelo TranslationService, não pelo DatePipe nem pelo DecimalPipe: ' +
    'esses leem o LOCALE_ID fixado na compilação e não conseguem acompanhar uma troca em execução.',

  'seo.home.description':
    '%title%: substitua isto por uma ou duas frases sobre o site. ' +
    'É o que os resultados de pesquisa mostram abaixo do título.',
  'seo.notFound.title': 'Página não encontrada',
  'seo.notFound.description':
    'Não há nenhuma página neste endereço. O link pode estar desatualizado.',
  'site.languages': 'Idiomas',
  'site.prerendered':
    'Esta página é pré-renderizada uma vez por idioma. Os links acima são URLs reais, ' +
    'então um rastreador indexa cada idioma separadamente.',

  'starter.lead':
    'Tudo abaixo vem dos tokens do design system, que declaram o modo claro e o escuro ' +
    'numa única folha de estilos. Mude o esquema de cores do sistema e a página inteira ' +
    'acompanha sem renderizar de novo.',
  'starter.tokensHeading': 'Tokens',
  'starter.tokensNote':
    'Cada combinação acima cumpre o contraste WCAG nos dois modos e em todas as paletas. A verificação:',
  'starter.componentsHeading': 'Componentes',
  'starter.primary': 'Principal',
  'starter.secondary': 'Secundário',
  'starter.ghost': 'Discreto',
  'starter.danger': 'Perigo',
  'starter.disabled': 'Desativado',
  'starter.emailLabel': 'Endereço de e-mail',
  'starter.emailHint': 'Digite algo sem @ para ver o estado de erro.',
  'starter.emailError': 'Isso não parece um endereço de e-mail.',
  'starter.componentsSource': 'O código deles:',
  'starter.componentsStories': 'As histórias deles, no Storybook:',
  'starter.nextHeading': 'Próximos passos',
  'starter.nextReplace': 'Substitua esta página:',
  'starter.nextRules': 'As regras deste workspace:',
  'starter.nextScripts': 'Cada script, com uma linha sobre cada um:',
  'starter.nextPalette': 'Adicione uma paleta:',
};

const ar: Messages = {
  'language.label': 'اللغة',

  'showcase.heading': 'الترجمة',
  'showcase.intro': 'يُبحث عن كل نص أدناه أثناء التشغيل.',
  'showcase.active': 'النشطة: {locale}، الاتجاه {direction}.',
  'showcase.plain.label': 'مفتاح بسيط',
  'showcase.plain.value': 'لا شيء لاستبداله هنا.',
  'showcase.interpolated.label': 'عنصر نائب',
  'showcase.greeting': 'مرحبًا يا {name}!',
  'showcase.plural.label': 'الجمع',
  // All six CLDR categories, which is the point of delegating to Intl.
  'showcase.items.zero': 'لا عناصر في السلة',
  'showcase.items.one': 'عنصر واحد في السلة',
  'showcase.items.two': 'عنصران في السلة',
  'showcase.items.few': '{count} عناصر في السلة',
  'showcase.items.many': '{count} عنصرًا في السلة',
  'showcase.items.other': '{count} عنصر في السلة',
  'showcase.fewer': 'واحد أقل',
  'showcase.more': 'واحد أكثر',
  'showcase.number.label': 'رقم',
  'showcase.currency.label': 'عملة',
  'showcase.date.label': 'تاريخ',
  'showcase.relative.label': 'وقت نسبي',
  'showcase.direction.label': 'الاتجاه',
  'showcase.direction.ltr': 'من اليسار إلى اليمين',
  'showcase.direction.rtl': 'من اليمين إلى اليسار',
  'showcase.footnote':
    'تمر الأرقام والتواريخ عبر TranslationService، لا عبر DatePipe أو DecimalPipe: ' +
    'فهذان يقرآن LOCALE_ID المحدد وقت البناء ولا يمكنهما اتباع تبديل اللغة أثناء التشغيل.',

  'seo.home.description':
    '%title%: استبدل هذا بجملة أو جملتين عن الموقع. ' + 'هذا ما تعرضه نتائج البحث تحت العنوان.',
  'seo.notFound.title': 'الصفحة غير موجودة',
  'seo.notFound.description': 'لا توجد صفحة على هذا العنوان. ربما يكون الرابط قديمًا.',
  'site.languages': 'اللغات',
  'site.prerendered':
    'تُعرض هذه الصفحة مسبقًا مرة لكل لغة. الروابط أعلاه عناوين URL حقيقية، ' +
    'لذا يفهرس الزاحف كل لغة على حدة.',

  'starter.lead':
    'كل ما يلي مأخوذ من رموز نظام التصميم، التي تعرّف الوضعين الفاتح والداكن في ورقة ' +
    'أنماط واحدة. غيّر نظام ألوان جهازك وستتبعه الصفحة كلها دون إعادة عرض.',
  'starter.tokensHeading': 'الرموز',
  'starter.tokensNote': 'كل زوج أعلاه يحقق تباين WCAG في الوضعين وفي كل لوحة ألوان. الفحص:',
  'starter.componentsHeading': 'المكونات',
  'starter.primary': 'أساسي',
  'starter.secondary': 'ثانوي',
  'starter.ghost': 'شفاف',
  'starter.danger': 'خطر',
  'starter.disabled': 'معطّل',
  'starter.emailLabel': 'البريد الإلكتروني',
  'starter.emailHint': 'اكتب شيئًا دون @ لترى حالة الخطأ.',
  'starter.emailError': 'لا يبدو هذا عنوان بريد إلكتروني.',
  'starter.componentsSource': 'شيفرتها:',
  'starter.componentsStories': 'قصصها، في Storybook:',
  'starter.nextHeading': 'التالي',
  'starter.nextReplace': 'استبدل هذه الصفحة:',
  'starter.nextRules': 'قواعد مساحة العمل هذه:',
  'starter.nextScripts': 'كل سكربت، مع سطر عن كل منها:',
  'starter.nextPalette': 'أضف لوحة ألوان:',
};

const he: Messages = {
  'language.label': 'שפה',

  'showcase.heading': 'תרגום',
  'showcase.intro': 'כל טקסט למטה נשלף בזמן ריצה.',
  'showcase.active': 'פעילה: {locale}, כיוון {direction}.',
  'showcase.plain.label': 'מפתח פשוט',
  'showcase.plain.value': 'אין כאן מה להחליף.',
  'showcase.interpolated.label': 'ממלא מקום',
  'showcase.greeting': 'שלום, {name}!',
  'showcase.plural.label': 'רבים',
  'showcase.items.one': 'פריט אחד בסל',
  'showcase.items.two': 'שני פריטים בסל',
  'showcase.items.other': '{count} פריטים בסל',
  'showcase.fewer': 'אחד פחות',
  'showcase.more': 'אחד יותר',
  'showcase.number.label': 'מספר',
  'showcase.currency.label': 'מטבע',
  'showcase.date.label': 'תאריך',
  'showcase.relative.label': 'זמן יחסי',
  'showcase.direction.label': 'כיוון',
  'showcase.direction.ltr': 'משמאל לימין',
  'showcase.direction.rtl': 'מימין לשמאל',
  'showcase.footnote':
    'מספרים ותאריכים עוברים דרך TranslationService, לא דרך DatePipe או DecimalPipe: ' +
    'אלה קוראים את ה-LOCALE_ID שנקבע בבנייה ואינם יכולים לעקוב אחר החלפה בזמן ריצה.',

  'seo.home.description':
    '%title%: החליפו את זה במשפט או שניים על האתר. ' + 'זה מה שתוצאות החיפוש מציגות מתחת לכותרת.',
  'seo.notFound.title': 'הדף לא נמצא',
  'seo.notFound.description': 'אין דף בכתובת הזו. ייתכן שהקישור ישן.',
  'site.languages': 'שפות',
  'site.prerendered':
    'הדף הזה מרונדר מראש פעם אחת לכל שפה. הקישורים למעלה הם כתובות URL אמיתיות, ' +
    'כך שסורק מאנדקס כל שפה בנפרד.',

  'starter.lead':
    'כל מה שלמטה לקוח מהטוקנים של מערכת העיצוב, שמגדירים מצב בהיר וכהה בגיליון סגנונות ' +
    'אחד. החליפו את ערכת הצבעים של המערכת וכל הדף יתעדכן בלי רינדור מחדש.',
  'starter.tokensHeading': 'טוקנים',
  'starter.tokensNote': 'כל צמד למעלה עומד בניגודיות WCAG בשני המצבים ובכל פלטה. הבדיקה:',
  'starter.componentsHeading': 'רכיבים',
  'starter.primary': 'ראשי',
  'starter.secondary': 'משני',
  'starter.ghost': 'שקוף',
  'starter.danger': 'סכנה',
  'starter.disabled': 'מושבת',
  'starter.emailLabel': 'כתובת אימייל',
  'starter.emailHint': 'הקלידו משהו בלי @ כדי לראות את מצב השגיאה.',
  'starter.emailError': 'זה לא נראה כמו כתובת אימייל.',
  'starter.componentsSource': 'קוד המקור שלהם:',
  'starter.componentsStories': 'הסיפורים שלהם, ב-Storybook:',
  'starter.nextHeading': 'הצעדים הבאים',
  'starter.nextReplace': 'החליפו את הדף הזה:',
  'starter.nextRules': 'הכללים של סביבת העבודה הזו:',
  'starter.nextScripts': 'כל סקריפט, עם שורה על כל אחד:',
  'starter.nextPalette': 'הוסיפו פלטה:',
};

const hi: Messages = {
  'language.label': 'भाषा',

  'showcase.heading': 'अनुवाद',
  'showcase.intro': 'नीचे का हर पाठ रनटाइम पर खोजा जाता है।',
  'showcase.active': 'सक्रिय: {locale}, दिशा {direction}।',
  'showcase.plain.label': 'सादी कुंजी',
  'showcase.plain.value': 'यहाँ बदलने के लिए कुछ नहीं है।',
  'showcase.interpolated.label': 'प्लेसहोल्डर',
  'showcase.greeting': 'नमस्ते, {name}!',
  'showcase.plural.label': 'बहुवचन',
  'showcase.items.one': 'टोकरी में {count} आइटम है',
  'showcase.items.other': 'टोकरी में {count} आइटम हैं',
  'showcase.fewer': 'एक कम',
  'showcase.more': 'एक और',
  'showcase.number.label': 'संख्या',
  'showcase.currency.label': 'मुद्रा',
  'showcase.date.label': 'तारीख',
  'showcase.relative.label': 'सापेक्ष समय',
  'showcase.direction.label': 'दिशा',
  'showcase.direction.ltr': 'बाएँ से दाएँ',
  'showcase.direction.rtl': 'दाएँ से बाएँ',
  'showcase.footnote':
    'संख्याएँ और तारीखें TranslationService से होकर जाती हैं, DatePipe या DecimalPipe से नहीं: ' +
    'वे बिल्ड के समय तय LOCALE_ID पढ़ते हैं और रनटाइम पर भाषा बदलने का पालन नहीं कर सकते।',

  'seo.home.description':
    '%title%: इसे साइट के बारे में एक-दो वाक्यों से बदलें। ' +
    'खोज परिणाम शीर्षक के नीचे यही दिखाते हैं।',
  'seo.notFound.title': 'पेज नहीं मिला',
  'seo.notFound.description': 'इस पते पर कोई पेज नहीं है। लिंक पुराना हो सकता है।',
  'site.languages': 'भाषाएँ',
  'site.prerendered':
    'यह पेज हर भाषा के लिए एक बार प्रीरेंडर होता है। ऊपर के लिंक असली URL हैं, ' +
    'इसलिए क्रॉलर हर भाषा को अलग से इंडेक्स करता है।',

  'starter.lead':
    'नीचे का सब कुछ डिज़ाइन सिस्टम के टोकन से आता है, जो लाइट और डार्क को एक ही ' +
    'स्टाइलशीट में घोषित करते हैं। अपने सिस्टम की कलर स्कीम बदलें और पूरा पेज बिना ' +
    'दोबारा रेंडर हुए साथ बदल जाता है।',
  'starter.tokensHeading': 'टोकन',
  'starter.tokensNote':
    'ऊपर की हर जोड़ी दोनों मोड और हर पैलेट में WCAG कंट्रास्ट पर खरी उतरती है। जाँच:',
  'starter.componentsHeading': 'कंपोनेंट',
  'starter.primary': 'प्राथमिक',
  'starter.secondary': 'द्वितीयक',
  'starter.ghost': 'घोस्ट',
  'starter.danger': 'खतरा',
  'starter.disabled': 'अक्षम',
  'starter.emailLabel': 'ईमेल पता',
  'starter.emailHint': 'त्रुटि की स्थिति देखने के लिए @ के बिना कुछ लिखें।',
  'starter.emailError': 'यह ईमेल पता नहीं लगता।',
  'starter.componentsSource': 'इनका सोर्स:',
  'starter.componentsStories': 'इनकी स्टोरीज़, Storybook में:',
  'starter.nextHeading': 'आगे',
  'starter.nextReplace': 'यह पेज बदलें:',
  'starter.nextRules': 'इस वर्कस्पेस के नियम:',
  'starter.nextScripts': 'हर स्क्रिप्ट, हर एक पर एक पंक्ति के साथ:',
  'starter.nextPalette': 'एक पैलेट जोड़ें:',
};

const ja: Messages = {
  'language.label': '言語',

  'showcase.heading': '翻訳',
  'showcase.intro': '以下のテキストはすべて実行時に参照されます。',
  'showcase.active': '現在: {locale}、書字方向 {direction}。',
  'showcase.plain.label': '単純なキー',
  'showcase.plain.value': 'ここには置き換えるものがありません。',
  'showcase.interpolated.label': 'プレースホルダー',
  'showcase.greeting': 'こんにちは、{name}さん!',
  'showcase.plural.label': '複数形',
  'showcase.items.other': 'かごに{count}個の商品',
  'showcase.fewer': '1つ減らす',
  'showcase.more': '1つ増やす',
  'showcase.number.label': '数値',
  'showcase.currency.label': '通貨',
  'showcase.date.label': '日付',
  'showcase.relative.label': '相対時間',
  'showcase.direction.label': '書字方向',
  'showcase.direction.ltr': '左から右',
  'showcase.direction.rtl': '右から左',
  'showcase.footnote':
    '数値と日付は DatePipe や DecimalPipe ではなく TranslationService を通します。' +
    'これらはビルド時の LOCALE_ID を読むため、実行時の切り替えに追従できません。',

  'seo.home.description':
    '%title%: ここをサイトについての一、二文に置き換えてください。' +
    '検索結果のタイトルの下に表示される文です。',
  'seo.notFound.title': 'ページが見つかりません',
  'seo.notFound.description': 'このアドレスにはページがありません。リンクが古い可能性があります。',
  'site.languages': '言語',
  'site.prerendered':
    'このページは言語ごとに一度プリレンダリングされます。上のリンクは実際の URL なので、' +
    'クローラーは言語ごとに別々にインデックスします。',

  'starter.lead':
    '以下はすべてデザインシステムのトークンから描画されています。トークンはライトとダークを' +
    '一つのスタイルシートで宣言しているので、システムの配色を切り替えると、再描画なしで' +
    'ページ全体が追従します。',
  'starter.tokensHeading': 'トークン',
  'starter.tokensNote':
    '上の組み合わせはすべて、両方のモードとすべてのパレットで WCAG のコントラストを満たしています。確認方法:',
  'starter.componentsHeading': 'コンポーネント',
  'starter.primary': 'プライマリ',
  'starter.secondary': 'セカンダリ',
  'starter.ghost': 'ゴースト',
  'starter.danger': '危険',
  'starter.disabled': '無効',
  'starter.emailLabel': 'メールアドレス',
  'starter.emailHint': '@ を含まない文字を入力すると、エラー状態を確認できます。',
  'starter.emailError': 'メールアドレスの形式ではないようです。',
  'starter.componentsSource': 'ソース:',
  'starter.componentsStories': 'Storybook のストーリー:',
  'starter.nextHeading': '次に',
  'starter.nextReplace': 'このページを置き換える:',
  'starter.nextRules': 'このワークスペースのルール:',
  'starter.nextScripts': '各スクリプトとその説明:',
  'starter.nextPalette': 'パレットを追加する:',
};

const ko: Messages = {
  'language.label': '언어',

  'showcase.heading': '번역',
  'showcase.intro': '아래의 모든 문자열은 런타임에 조회됩니다.',
  'showcase.active': '현재: {locale}, 쓰기 방향 {direction}.',
  'showcase.plain.label': '단순 키',
  'showcase.plain.value': '여기에는 바꿀 것이 없습니다.',
  'showcase.interpolated.label': '자리 표시자',
  'showcase.greeting': '안녕하세요, {name}님!',
  'showcase.plural.label': '복수형',
  'showcase.items.other': '장바구니에 상품 {count}개',
  'showcase.fewer': '하나 빼기',
  'showcase.more': '하나 더하기',
  'showcase.number.label': '숫자',
  'showcase.currency.label': '통화',
  'showcase.date.label': '날짜',
  'showcase.relative.label': '상대 시간',
  'showcase.direction.label': '쓰기 방향',
  'showcase.direction.ltr': '왼쪽에서 오른쪽',
  'showcase.direction.rtl': '오른쪽에서 왼쪽',
  'showcase.footnote':
    '숫자와 날짜는 DatePipe나 DecimalPipe가 아니라 TranslationService를 거칩니다. ' +
    '이 파이프들은 빌드 시점의 LOCALE_ID를 읽기 때문에 런타임 전환을 따라갈 수 없습니다.',

  'seo.home.description':
    '%title%: 이 문장을 사이트에 대한 한두 문장으로 바꾸세요. ' +
    '검색 결과에서 제목 아래에 표시되는 내용입니다.',
  'seo.notFound.title': '페이지를 찾을 수 없습니다',
  'seo.notFound.description': '이 주소에는 페이지가 없습니다. 링크가 오래되었을 수 있습니다.',
  'site.languages': '언어',
  'site.prerendered':
    '이 페이지는 언어마다 한 번씩 미리 렌더링됩니다. 위의 링크는 실제 URL이므로 ' +
    '크롤러가 언어별로 따로 색인합니다.',

  'starter.lead':
    '아래의 모든 것은 디자인 시스템의 토큰에서 나옵니다. 토큰은 라이트와 다크를 하나의 ' +
    '스타일시트에 선언하므로, 시스템 색 구성표를 바꾸면 다시 렌더링하지 않아도 페이지 ' +
    '전체가 따라 바뀝니다.',
  'starter.tokensHeading': '토큰',
  'starter.tokensNote':
    '위의 모든 조합은 두 모드와 모든 팔레트에서 WCAG 대비 기준을 충족합니다. 검사:',
  'starter.componentsHeading': '컴포넌트',
  'starter.primary': '기본',
  'starter.secondary': '보조',
  'starter.ghost': '고스트',
  'starter.danger': '위험',
  'starter.disabled': '비활성',
  'starter.emailLabel': '이메일 주소',
  'starter.emailHint': '@ 없이 입력하면 오류 상태를 볼 수 있습니다.',
  'starter.emailError': '이메일 주소 형식이 아닌 것 같습니다.',
  'starter.componentsSource': '소스 코드:',
  'starter.componentsStories': 'Storybook의 스토리:',
  'starter.nextHeading': '다음 단계',
  'starter.nextReplace': '이 페이지 바꾸기:',
  'starter.nextRules': '이 워크스페이스의 규칙:',
  'starter.nextScripts': '모든 스크립트와 각각의 설명:',
  'starter.nextPalette': '팔레트 추가하기:',
};

const zh: Messages = {
  'language.label': '语言',

  'showcase.heading': '翻译',
  'showcase.intro': '下面的每段文字都在运行时查找。',
  'showcase.active': '当前：{locale}，书写方向 {direction}。',
  'showcase.plain.label': '普通键',
  'showcase.plain.value': '这里没有需要替换的内容。',
  'showcase.interpolated.label': '占位符',
  'showcase.greeting': '你好，{name}！',
  'showcase.plural.label': '复数',
  'showcase.items.other': '购物篮中有 {count} 件商品',
  'showcase.fewer': '减少一件',
  'showcase.more': '增加一件',
  'showcase.number.label': '数字',
  'showcase.currency.label': '货币',
  'showcase.date.label': '日期',
  'showcase.relative.label': '相对时间',
  'showcase.direction.label': '书写方向',
  'showcase.direction.ltr': '从左到右',
  'showcase.direction.rtl': '从右到左',
  'showcase.footnote':
    '数字和日期通过 TranslationService 格式化，而不是 DatePipe 或 DecimalPipe：' +
    '后两者读取构建时的 LOCALE_ID，无法跟随运行时的切换。',

  'seo.home.description':
    '%title%：请把这里换成一两句介绍网站的话。' + '搜索结果会在标题下方显示这段文字。',
  'seo.notFound.title': '找不到页面',
  'seo.notFound.description': '此地址没有页面。链接可能已经过时。',
  'site.languages': '语言',
  'site.prerendered':
    '此页面按每种语言各预渲染一次。上方的链接是真实的 URL，' + '因此爬虫会分别索引每种语言。',

  'starter.lead':
    '下面的一切都来自设计系统的令牌，它们在同一个样式表中声明浅色和深色。' +
    '切换系统的配色方案，整个页面会随之变化，无需重新渲染。',
  'starter.tokensHeading': '令牌',
  'starter.tokensNote': '上面的每组配色在两种模式和每个调色板中都符合 WCAG 对比度。检查命令：',
  'starter.componentsHeading': '组件',
  'starter.primary': '主要',
  'starter.secondary': '次要',
  'starter.ghost': '幽灵',
  'starter.danger': '危险',
  'starter.disabled': '已禁用',
  'starter.emailLabel': '电子邮件地址',
  'starter.emailHint': '输入不含 @ 的内容即可查看错误状态。',
  'starter.emailError': '这看起来不像电子邮件地址。',
  'starter.componentsSource': '源代码：',
  'starter.componentsStories': 'Storybook 中的故事：',
  'starter.nextHeading': '下一步',
  'starter.nextReplace': '替换此页面：',
  'starter.nextRules': '此工作区的规则：',
  'starter.nextScripts': '每个脚本，各附一行说明：',
  'starter.nextPalette': '添加调色板：',
};

const STARTER_MESSAGES: Readonly<Record<string, Messages>> = {
  en,
  es,
  fr,
  de,
  it,
  pt,
  ar,
  he,
  hi,
  ja,
  ko,
  zh,
};

/** The languages the starter strings are written in, for the tests and the docs. */
export const STARTER_LANGUAGES = Object.keys(STARTER_MESSAGES);

/**
 * The starter strings for `tag`, or `undefined` when the generator has none.
 *
 * A region inherits its base language's, as its endonym does in `localeInfo`:
 * `pt-BR` gets the Portuguese strings, which a translator then adjusts, rather
 * than tagged English.
 */
export function starterMessages(tag: string): Messages | undefined {
  return STARTER_MESSAGES[tag] ?? STARTER_MESSAGES[tag.split('-')[0]!.toLowerCase()];
}
