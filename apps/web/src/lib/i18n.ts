// Reader-facing words on every site, in each language ANR supports. IPTC labels are English only,
// so these names are ANR's own (docs/technical-design.md#iptc-standards).
import type { Language } from "@anr/core";

export interface Words {
  latest: string;
  nothingYet: string;
  /** On a news home: the newest pieces of the other series, and the way to the whole timeline. */
  latestPieces: string;
  /** A front page section's link to all of it (D182). */
  seeMore: string;
  /** A front page's list of the Reference entries the recent news names most (D182). */
  inTheNews: string;
  search: string;
  searchPlaceholder: string;
  noResults: string;
  aiPolicy: string;
  corrections: string;
  correctionsNone: string;
  corrected: string;
  notFound: string;
  /** Read after a link that opens in a new tab (ShabUI's ExternalLink). */
  newTab: string;
  /** The AI policy page: why each piece is AI-made, and how claims are checked. */
  aiPolicyBody: (o: { newsroom: string; editor: string }) => {
    heading: string;
    text: string;
    id?: string;
  }[];
  /** The corrections page: who owns corrections and how a reader challenges a piece. */
  correctionsBody: (o: { owner: string }) => string;
  /** An episode's page (D181): its facts, chapters, transcript and player. */
  episode: {
    date: string;
    length: string;
    chapters: string;
    transcript: string;
    /** A transcript section without a heading. */
    part: (n: string) => string;
    /** The length in minutes and seconds, digits already in the page's language. */
    duration: (minutes: string | null, seconds: string | null) => string;
    /** The feed link's heading in the facts. */
    subscribe: string;
    feed: string;
    /** "Play from 05:36", on a chapter's time. */
    playFrom: (time: string) => string;
    player: {
      play: string;
      pause: string;
      back: (seconds: string) => string;
      forward: (seconds: string) => string;
      /** The scrubber's name, and its spoken value: "05:36 of 11:06". */
      position: string;
      of: (now: string, length: string) => string;
      speed: (rate: string) => string;
      /** Brings the spoken turn back into view. */
      follow: string;
      close: string;
    };
  };
  /** A reader's challenge: the form on every piece and the reader's private status page (D114). */
  challenge: {
    heading: string;
    intro: string;
    text: string;
    source: string;
    send: string;
    failed: string;
    /** Said where the form is while challenges are closed (D178). */
    closed: string;
    status: string;
    keep: string;
    received: string;
    acknowledgeBy: string;
    answerBy: string;
    acknowledged: string;
    answered: string;
    upheld: string;
    rejected: string;
  };
}

const en: Words = {
  latest: "Latest",
  nothingYet: "Nothing published yet.",
  latestPieces: "Latest pieces",
  seeMore: "See more",
  inTheNews: "In the news",
  search: "Search",
  searchPlaceholder: "Search this site",
  noResults: "No results.",
  aiPolicy: "AI policy",
  corrections: "Corrections",
  correctionsNone: "No corrections so far.",
  corrected: "Corrected",
  notFound: "Page not found.",
  newTab: "(opens in a new tab)",
  aiPolicyBody: ({ newsroom, editor }) => [
    {
      heading: "AI-made",
      text: `Every piece on ${newsroom} is researched and written by AI agents and says so with a label. Its editor-in-chief, ${editor}, sets what is covered and approves every theme. A piece an editor changed is labelled "AI-made, edited by a person".`,
    },
    {
      heading: "Sources",
      text: "Agents write only from sources stored by ANR. Every fact cites a stored source and the passage it comes from.",
    },
    {
      id: FACT_CHECKING_ANCHOR,
      heading: "How claims are checked",
      text: "Before publication, code checks every quote against its source and requires two independent sources, or one primary source, for each fact. A separate AI model, never the one that wrote the piece, checks each fact against its passage. Anything that fails goes to a person. Editors review a random tenth of what publishes on its own.",
    },
  ],
  correctionsBody: ({ owner }) =>
    `${owner} owns corrections. A challenge is acknowledged within 24 hours and answered within 48. Every correction is published here and becomes a new check.`,
  episode: {
    date: "Date",
    length: "Length",
    chapters: "Chapters",
    transcript: "Transcript",
    part: (n) => `Part ${n}`,
    duration: (m, s) => [m && `${m} min`, s && `${s} s`].filter(Boolean).join(" "),
    subscribe: "Subscribe",
    feed: "Podcast feed (RSS)",
    playFrom: (t) => `Play from ${t}`,
    player: {
      play: "Play",
      pause: "Pause",
      back: (s) => `Back ${s} seconds`,
      forward: (s) => `Forward ${s} seconds`,
      position: "Position",
      of: (now, length) => `${now} of ${length}`,
      speed: (r) => `Playback speed: ${r}×`,
      follow: "Follow the text",
      close: "Close the player bar",
    },
  },
  challenge: {
    heading: "Is something wrong here?",
    intro:
      "Tell us what this piece gets wrong. We acknowledge every challenge within 24 hours and answer within 48. We keep nothing about you; the next page's address is how you see our answer.",
    text: "What is wrong (at least 20 characters)",
    source: "Where the correct information is, if anywhere (a link)",
    send: "Send",
    failed: "Your challenge could not be sent. Please try again later.",
    closed:
      "Challenges open once the form has spam protection. Published corrections are on the corrections page.",
    status: "Your challenge",
    keep: "Keep this page's address: it is the only way to see our answer.",
    received: "Received",
    acknowledgeBy: "Acknowledged by",
    answerBy: "Answered by",
    acknowledged: "Acknowledged",
    answered: "Answered",
    upheld: "Upheld: the piece now carries a correction.",
    rejected: "Not upheld: the piece stands.",
  },
};

const fa: Words = {
  latest: "تازه‌ترین‌ها",
  nothingYet: "هنوز چیزی منتشر نشده است.",
  latestPieces: "تازه‌ترین نوشته‌ها",
  seeMore: "بیشتر ببینید",
  inTheNews: "در خبرها",
  search: "جست‌وجو",
  searchPlaceholder: "جست‌وجو در این سایت",
  noResults: "نتیجه‌ای پیدا نشد.",
  aiPolicy: "سیاست هوش مصنوعی",
  corrections: "اصلاحیه‌ها",
  correctionsNone: "تاکنون اصلاحیه‌ای نداشته‌ایم.",
  corrected: "اصلاح‌شده",
  notFound: "صفحه پیدا نشد.",
  newTab: "(در زبانه‌ی تازه باز می‌شود)",
  aiPolicyBody: ({ newsroom, editor }) => [
    {
      heading: "ساخته‌شده با هوش مصنوعی",
      text: `هر مطلب ${newsroom} را عامل‌های هوش مصنوعی پژوهش می‌کنند و می‌نویسند و برچسب آن را دارد. سردبیر، ${editor}، تعیین می‌کند چه پوشش داده شود و هر موضوع را تأیید می‌کند. مطلبی که ویراستار تغییرش داده باشد برچسب «ساخته‌شده با هوش مصنوعی، ویراسته‌ی یک انسان» دارد.`,
    },
    {
      heading: "منابع",
      text: "عامل‌ها فقط از منابعی می‌نویسند که ANR ذخیره کرده است. هر واقعیت به یک منبع ذخیره‌شده و بخشی از متن آن ارجاع می‌دهد.",
    },
    {
      id: FACT_CHECKING_ANCHOR,
      heading: "ادعاها چطور بررسی می‌شوند",
      text: "پیش از انتشار، کد هر نقل‌قول را با منبعش می‌سنجد و برای هر واقعیت دو منبع مستقل یا یک منبع دست‌اول می‌خواهد. یک مدل هوش مصنوعی دیگر، هرگز همان که مطلب را نوشته، هر واقعیت را با متن منبعش بررسی می‌کند. هر چه رد شود به دست یک انسان می‌رسد. ویراستاران یک‌دهم تصادفی از مطالبی را که خودکار منتشر می‌شوند بازبینی می‌کنند.",
    },
  ],
  correctionsBody: ({ owner }) =>
    `مسئول اصلاحیه‌ها ${owner} است. هر اعتراض ظرف ۲۴ ساعت تأیید دریافت و ظرف ۴۸ ساعت پاسخ می‌گیرد. هر اصلاحیه اینجا منتشر می‌شود و به یک بررسی تازه تبدیل می‌شود.`,
  episode: {
    date: "تاریخ",
    length: "مدت",
    chapters: "بخش‌ها",
    transcript: "متن اپیزود",
    part: (n) => `بخش ${n}`,
    duration: (m, s) => [m && `${m} دقیقه`, s && `${s} ثانیه`].filter(Boolean).join(" و "),
    subscribe: "اشتراک",
    feed: "فید پادکست (RSS)",
    playFrom: (t) => `پخش از ${t}`,
    player: {
      play: "پخش",
      pause: "توقف",
      back: (s) => `${s} ثانیه عقب`,
      forward: (s) => `${s} ثانیه جلو`,
      position: "جای پخش",
      of: (now, length) => `${now} از ${length}`,
      speed: (r) => `سرعت پخش: ${r} برابر`,
      follow: "همراه متن",
      close: "بستن نوار پخش",
    },
  },
  challenge: {
    heading: "چیزی در این مطلب نادرست است؟",
    intro:
      "بگویید این مطلب کجا اشتباه کرده است. هر اعتراض ظرف ۲۴ ساعت تأیید دریافت و ظرف ۴۸ ساعت پاسخ می‌گیرد. چیزی درباره‌ی شما نگه نمی‌داریم؛ نشانی صفحه‌ی بعد تنها راه دیدن پاسخ ماست.",
    text: "چه چیزی نادرست است (دست‌کم ۲۰ نویسه)",
    source: "اطلاعات درست کجاست، اگر جایی هست (یک پیوند)",
    send: "ارسال",
    failed: "اعتراض شما فرستاده نشد. لطفاً بعداً دوباره امتحان کنید.",
    closed:
      "فرستادن اعتراض پس از راه‌اندازی محافظت این فرم در برابر هرزنامه باز می‌شود. اصلاحیه‌های منتشرشده در صفحه‌ی اصلاحیه‌ها هستند.",
    status: "اعتراض شما",
    keep: "نشانی این صفحه را نگه دارید: تنها راه دیدن پاسخ ماست.",
    received: "دریافت",
    acknowledgeBy: "تأیید دریافت تا",
    answerBy: "پاسخ تا",
    acknowledged: "تأیید دریافت",
    answered: "پاسخ",
    upheld: "پذیرفته شد: مطلب اکنون اصلاحیه دارد.",
    rejected: "پذیرفته نشد: مطلب به همان شکل می‌ماند.",
  },
};

const tr: Words = {
  latest: "Son yazılar",
  nothingYet: "Henüz bir şey yayımlanmadı.",
  latestPieces: "Son yazılar",
  seeMore: "Daha fazlası",
  inTheNews: "Haberlerde",
  search: "Ara",
  searchPlaceholder: "Bu sitede ara",
  noResults: "Sonuç yok.",
  aiPolicy: "Yapay zekâ politikası",
  corrections: "Düzeltmeler",
  correctionsNone: "Şu ana kadar düzeltme yok.",
  corrected: "Düzeltildi",
  notFound: "Sayfa bulunamadı.",
  newTab: "(yeni sekmede açılır)",
  aiPolicyBody: ({ newsroom, editor }) => [
    {
      heading: "Yapay zekâ ile üretildi",
      text: `${newsroom} sitesindeki her yazıyı yapay zekâ ajanları araştırır ve yazar; her yazı bunu bir etiketle belirtir. Genel yayın yönetmeni ${editor} neyin işleneceğine karar verir ve her temayı onaylar. Bir editörün değiştirdiği yazı "Yapay zekâ ile üretildi, bir insan tarafından düzenlendi" etiketini taşır.`,
    },
    {
      heading: "Kaynaklar",
      text: "Ajanlar yalnızca ANR'nin sakladığı kaynaklardan yazar. Her olgu saklanan bir kaynağa ve o kaynaktaki pasaja dayanır.",
    },
    {
      id: FACT_CHECKING_ANCHOR,
      heading: "İddialar nasıl doğrulanır",
      text: "Yayından önce kod her alıntıyı kaynağıyla karşılaştırır ve her olgu için iki bağımsız kaynak ya da bir birincil kaynak ister. Yazıyı yazandan farklı bir yapay zekâ modeli her olguyu kaynağındaki pasajla karşılaştırır. Geçemeyen her şey bir insana gider. Editörler kendiliğinden yayımlananların rastgele onda birini sonradan inceler.",
    },
  ],
  correctionsBody: ({ owner }) =>
    `Düzeltmelerden ${owner} sorumludur. Her itiraz 24 saat içinde alındı olarak bildirilir ve 48 saat içinde yanıtlanır. Her düzeltme burada yayımlanır ve yeni bir kontrole dönüşür.`,
  episode: {
    date: "Tarih",
    length: "Süre",
    chapters: "Bölümler",
    transcript: "Döküm",
    part: (n) => `Bölüm ${n}`,
    duration: (m, s) => [m && `${m} dk`, s && `${s} sn`].filter(Boolean).join(" "),
    subscribe: "Abone ol",
    feed: "Podcast akışı (RSS)",
    playFrom: (t) => `${t} itibarıyla oynat`,
    player: {
      play: "Oynat",
      pause: "Duraklat",
      back: (s) => `${s} saniye geri`,
      forward: (s) => `${s} saniye ileri`,
      position: "Konum",
      of: (now, length) => `${now} / ${length}`,
      speed: (r) => `Oynatma hızı: ${r}×`,
      follow: "Metni takip et",
      close: "Oynatıcı çubuğunu kapat",
    },
  },
  challenge: {
    heading: "Burada yanlış bir şey mi var?",
    intro:
      "Bu yazının neyi yanlış verdiğini bize yazın. Her itirazı 24 saat içinde alındı olarak bildirir, 48 saat içinde yanıtlarız. Sizinle ilgili hiçbir şey saklamayız; yanıtımızı bir sonraki sayfanın adresinden görürsünüz.",
    text: "Yanlış olan ne (en az 20 karakter)",
    source: "Doğru bilgi nerede, varsa (bir bağlantı)",
    send: "Gönder",
    failed: "İtirazınız gönderilemedi. Lütfen daha sonra yeniden deneyin.",
    closed:
      "İtirazlar, form spama karşı korunduğunda açılacak. Yayımlanan düzeltmeler düzeltmeler sayfasında.",
    status: "İtirazınız",
    keep: "Bu sayfanın adresini saklayın: yanıtımızı görmenin tek yolu budur.",
    received: "Alındı",
    acknowledgeBy: "Alındı bildirimi en geç",
    answerBy: "Yanıt en geç",
    acknowledged: "Alındı bildirildi",
    answered: "Yanıtlandı",
    upheld: "Kabul edildi: yazıya bir düzeltme eklendi.",
    rejected: "Kabul edilmedi: yazı olduğu gibi kalıyor.",
  },
};

export const WORDS: Record<Language, Words> = { en, fa, tr };

/** The id of the AI policy section that the fact-checking trust indicator links to. */
export const FACT_CHECKING_ANCHOR = "fact-checking";
