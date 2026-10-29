// Reader-facing words on every site, in each language ANR supports. IPTC labels are English only,
// so these names are ANR's own (docs/technical-design.md#iptc-standards).
import type { Language } from "@anr/core";

export interface Words {
  latest: string;
  nothingYet: string;
  search: string;
  searchPlaceholder: string;
  noResults: string;
  aiPolicy: string;
  corrections: string;
  correctionsNone: string;
  corrected: string;
  notFound: string;
  /** The AI policy page: why each piece is AI-made, and how claims are checked. */
  aiPolicyBody: (o: { newsroom: string; editor: string }) => {
    heading: string;
    text: string;
    id?: string;
  }[];
  /** The corrections page: who owns corrections and how a reader challenges a piece. */
  correctionsBody: (o: { owner: string }) => string;
  /** A reader's challenge: the form on every piece and the reader's private status page (D114). */
  challenge: {
    heading: string;
    intro: string;
    text: string;
    source: string;
    send: string;
    failed: string;
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
  search: "Search",
  searchPlaceholder: "Search this site",
  noResults: "No results.",
  aiPolicy: "AI policy",
  corrections: "Corrections",
  correctionsNone: "No corrections so far.",
  corrected: "Corrected",
  notFound: "Page not found.",
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
  challenge: {
    heading: "Is something wrong here?",
    intro:
      "Tell us what this piece gets wrong. We acknowledge every challenge within 24 hours and answer within 48. We keep nothing about you; the next page's address is how you see our answer.",
    text: "What is wrong (at least 20 characters)",
    source: "Where the correct information is, if anywhere (a link)",
    send: "Send",
    failed: "Your challenge could not be sent. Please try again later.",
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
  search: "جست‌وجو",
  searchPlaceholder: "جست‌وجو در این سایت",
  noResults: "نتیجه‌ای پیدا نشد.",
  aiPolicy: "سیاست هوش مصنوعی",
  corrections: "اصلاحیه‌ها",
  correctionsNone: "تاکنون اصلاحیه‌ای نداشته‌ایم.",
  corrected: "اصلاح‌شده",
  notFound: "صفحه پیدا نشد.",
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
  challenge: {
    heading: "چیزی در این مطلب نادرست است؟",
    intro:
      "بگویید این مطلب کجا اشتباه کرده است. هر اعتراض ظرف ۲۴ ساعت تأیید دریافت و ظرف ۴۸ ساعت پاسخ می‌گیرد. چیزی درباره‌ی شما نگه نمی‌داریم؛ نشانی صفحه‌ی بعد تنها راه دیدن پاسخ ماست.",
    text: "چه چیزی نادرست است (دست‌کم ۲۰ نویسه)",
    source: "اطلاعات درست کجاست، اگر جایی هست (یک پیوند)",
    send: "ارسال",
    failed: "اعتراض شما فرستاده نشد. لطفاً بعداً دوباره امتحان کنید.",
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
  search: "Ara",
  searchPlaceholder: "Bu sitede ara",
  noResults: "Sonuç yok.",
  aiPolicy: "Yapay zekâ politikası",
  corrections: "Düzeltmeler",
  correctionsNone: "Şu ana kadar düzeltme yok.",
  corrected: "Düzeltildi",
  notFound: "Sayfa bulunamadı.",
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
  challenge: {
    heading: "Burada yanlış bir şey mi var?",
    intro:
      "Bu yazının neyi yanlış verdiğini bize yazın. Her itirazı 24 saat içinde alındı olarak bildirir, 48 saat içinde yanıtlarız. Sizinle ilgili hiçbir şey saklamayız; yanıtımızı bir sonraki sayfanın adresinden görürsünüz.",
    text: "Yanlış olan ne (en az 20 karakter)",
    source: "Doğru bilgi nerede, varsa (bir bağlantı)",
    send: "Gönder",
    failed: "İtirazınız gönderilemedi. Lütfen daha sonra yeniden deneyin.",
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
