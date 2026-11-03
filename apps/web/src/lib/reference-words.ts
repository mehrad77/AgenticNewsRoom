// The Reference's words in each language ANR supports (D162). The Persian ones follow the old
// archive, whose text the Reference carries (D165).
import type { Language } from "@anr/core";

export interface ReferenceWords {
  reference: string;
  referenceIntro: string;
  news: string;
  newsIntro: string;
  newsCount: (n: string) => string;
  classics: string;
  classicsIntro: string;
  classicsCount: (n: string) => string;
  papersCount: (n: string) => string;
  oldest: (newest: string) => string;
  /** D164: imported text, shown as it was. */
  imported: string;
  approximate: string;
  orgLabel: string;
  kindLabel: string;
  allOrgs: string;
  allKinds: string;
  filter: string;
  clear: string;
  nothing: string;
  inPersian: string;
  newsKinds: Record<string, string>;
  urlTypes: Record<string, string>;
  telegramPost: (n: string) => string;
  related: string;
  classicLabel: string;
  facts: {
    date: string;
    authors: string;
    venue: string;
    citations: (n: string, source: string, asOf: string) => string;
    citationsLabel: string;
    affiliations: string;
  };
  sections: Record<string, string>;
  summaryHeading: string;
  excerpts: string;
  relatedPapers: string;
  references: string;
  citedBy: string;
  sources: string;
  links: string;
  onTelegram: string;
  newer: string;
  older: string;
}

const NEWS_KINDS_EN = {
  model: "Model",
  product: "Product",
  tool: "Tool",
  "research-blog": "Research",
  "open-source": "Open source",
  funding: "Funding",
  org: "Organisation",
  other: "Other",
};

const en: ReferenceWords = {
  reference: "Reference",
  referenceIntro:
    "The papers and lab news behind our coverage, kept in one place: classic papers with their story, and a timeline of what the labs released.",
  news: "Lab news",
  newsIntro:
    "A timeline of what the AI labs released, newest first: models, products, tools, open-source releases, funding and company news. Each item links to its official page.",
  newsCount: (n) => `${n} news items`,
  classics: "Classic papers",
  classicsIntro:
    "The papers today's work is built on, each with its context, its story and what came after.",
  classicsCount: (n) => `${n} classic papers`,
  papersCount: (n) => `${n} papers`,
  oldest: (newest) => `oldest item (newest: ${newest})`,
  imported:
    "Imported from the old archive and machine-translated from Persian. Not checked by ANR's verifier.",
  approximate: "(approximate date)",
  orgLabel: "Lab or company",
  kindLabel: "Kind of news",
  allOrgs: "All",
  allKinds: "All kinds",
  filter: "Filter",
  clear: "Clear filters",
  nothing: "Nothing here yet.",
  inPersian: "Parts of this entry are not translated yet and are shown in Persian.",
  newsKinds: NEWS_KINDS_EN,
  urlTypes: {
    official: "Official page",
    docs: "Official docs",
    repo: "Official repository",
    press: "Press report",
    wikipedia: "Wikipedia",
    other: "Source",
  },
  telegramPost: (n) => `Telegram post ${n}`,
  related: "Related",
  classicLabel: "Classic paper",
  facts: {
    date: "Date",
    authors: "Authors",
    venue: "Published in",
    citations: (n, source, asOf) =>
      `about ${n} citations on ${source}${asOf ? `, as of ${asOf}` : ""}`,
    citationsLabel: "Citations",
    affiliations: "Affiliations",
  },
  sections: {
    overview: "What this paper is",
    problem: "The problem",
    idea: "Idea and method",
    why: "Why it is historic",
    story: "The story of the paper",
    after: "What came after",
    post: "From the channel",
    summary: "Summary",
  },
  summaryHeading: "Summary",
  excerpts: "Excerpts from the paper",
  relatedPapers: "Related papers",
  references: "Papers it cites that are in the archive or the channel",
  citedBy: "Papers in the archive built on it",
  sources: "Sources",
  links: "Links",
  onTelegram: "On Telegram",
  newer: "Newer paper",
  older: "Older paper",
};

const fa: ReferenceWords = {
  reference: "مرجع",
  referenceIntro:
    "مقاله‌ها و خبرهای لابراتوارها که پشت پوشش ما هستند، یک‌جا: مقاله‌های کلاسیک با ماجرایشان، و خط زمانی آنچه لابراتوارها منتشر کرده‌اند.",
  news: "اخبار لابراتوارها و محصولات",
  newsIntro:
    "خط زمانی خبرهای لابراتوارهای هوش مصنوعی، از تازه‌ترین به قدیمی‌ترین: مدل‌ها، محصول‌ها، ابزارها، انتشارهای متن‌باز، سرمایه‌گذاری‌ها و خبرهای سازمانی. هر خبر پیوند رسمی خودش را دارد.",
  newsCount: (n) => `${n} خبر`,
  classics: "مقاله‌های کلاسیک",
  classicsIntro:
    "مقاله‌های پایه‌ای که کارهای امروز روی آن‌ها بنا شده‌اند، هرکدام با زمینه، ماجرا و اثرش.",
  classicsCount: (n) => `${n} مقاله‌ی کلاسیک`,
  papersCount: (n) => `${n} مقاله`,
  oldest: (newest) => `قدیمی‌ترین خبر (تا ${newest})`,
  imported: "از آرشیو قدیمی آمده است. بررسی‌کننده‌ی ANR این متن را نسنجیده است.",
  approximate: "(تاریخ تقریبی)",
  orgLabel: "لابراتوار یا شرکت",
  kindLabel: "نوع خبر",
  allOrgs: "همه",
  allKinds: "همه‌ی نوع‌ها",
  filter: "فیلتر",
  clear: "پاک کردن فیلترها",
  nothing: "هنوز چیزی اینجا نیست.",
  inPersian: "متن این مدخل به فارسی است.",
  newsKinds: {
    model: "مدل",
    product: "محصول",
    tool: "ابزار",
    "research-blog": "پژوهش",
    "open-source": "متن‌باز",
    funding: "سرمایه‌گذاری",
    org: "سازمان",
    other: "دیگر",
  },
  urlTypes: {
    official: "صفحه‌ی رسمی",
    docs: "مستندات رسمی",
    repo: "مخزن رسمی",
    press: "گزارش رسانه",
    wikipedia: "ویکی‌پدیا",
    other: "منبع",
  },
  telegramPost: (n) => `پیام تلگرام ${n}`,
  related: "مرتبط با",
  classicLabel: "مقاله‌ی کلاسیک",
  facts: {
    date: "تاریخ",
    authors: "نویسنده‌ها",
    venue: "محل انتشار",
    citations: (n, source, asOf) =>
      `حدود ${n} ارجاع در ${source} (تقریبی${asOf ? `، تا ${asOf}` : ""})`,
    citationsLabel: "ارجاع‌ها",
    affiliations: "نهاد نویسنده‌ها",
  },
  sections: {
    overview: "این مقاله چیست",
    problem: "مسئله",
    idea: "ایده و روش",
    why: "چرا این مقاله تاریخی است",
    story: "ماجرای مقاله",
    after: "بعد از این مقاله چه شد",
    post: "متن کانال",
    summary: "خلاصه",
  },
  summaryHeading: "خلاصه‌ی فارسی",
  excerpts: "بریده‌هایی از متن مقاله",
  relatedPapers: "مقاله‌های مرتبط",
  references: "ارجاع‌های این مقاله که در آرشیو یا کانال آمده‌اند",
  citedBy: "مقاله‌هایی از آرشیو که بر پایه‌ی این مقاله‌اند",
  sources: "منابع",
  links: "پیوندها",
  onTelegram: "در کانال تلگرام",
  newer: "مقاله‌ی تازه‌تر",
  older: "مقاله‌ی قدیمی‌تر",
};

const tr: ReferenceWords = {
  ...en,
  reference: "Başvuru",
  referenceIntro: "Haberlerimizin arkasındaki makaleler ve laboratuvar haberleri tek bir yerde.",
  news: "Laboratuvar haberleri",
  newsIntro:
    "Yapay zekâ laboratuvarlarının yayımladıkları, en yeniden en eskiye. Her haber resmî sayfasına bağlanır.",
  newsCount: (n) => `${n} haber`,
  classics: "Klasik makaleler",
  classicsIntro: "Bugünün çalışmalarının dayandığı makaleler, bağlamları ve hikâyeleriyle.",
  classicsCount: (n) => `${n} klasik makale`,
  papersCount: (n) => `${n} makale`,
  oldest: (newest) => `en eski haber (en yenisi: ${newest})`,
  imported:
    "Eski arşivden aktarıldı ve Farsçadan makine çevirisiyle çevrildi. ANR'nin doğrulayıcısı bu metni kontrol etmedi.",
  approximate: "(yaklaşık tarih)",
  orgLabel: "Laboratuvar ya da şirket",
  kindLabel: "Haber türü",
  allOrgs: "Tümü",
  allKinds: "Tüm türler",
  filter: "Süz",
  clear: "Süzgeçleri temizle",
  nothing: "Burada henüz bir şey yok.",
  inPersian: "Bu maddenin bazı bölümleri henüz çevrilmedi ve Farsça gösteriliyor.",
  classicLabel: "Klasik makale",
};

export const REFERENCE_WORDS: Record<Language, ReferenceWords> = { en, fa, tr };
