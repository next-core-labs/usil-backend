/** نص قانوني يُحقن في HTML قبل React حتى تبقى الصفحة مقروءة بلا جافاسكربت. */
import { REFUND_TIERS } from '../shared/refund-policy';

/** Same tier table the SPA renders — one source, so the two can't drift. */
const REFUND_TIER_ROWS = REFUND_TIERS.map(
  (tier) => `    <tr><td>${tier.window}</td><td>${tier.customer}</td><td>${tier.vendor}</td></tr>`,
).join('\n');

const ARTICLE_STYLE =
  'max-width:48rem;margin:2.5rem auto;padding:0 1rem 3rem;font-family:Tahoma,Arial,sans-serif;line-height:1.8;color:#344054;direction:rtl;text-align:right';

function article(title: string, inner: string): string {
  return `<article style="${ARTICLE_STYLE}" dir="rtl" lang="ar"><h1 style="color:#0A1A33;font-size:1.75rem">${title}</h1>${inner}</article>`;
}

const REFUND_INNER = `
<p style="font-size:12px;color:#667085">يوصل / Usil · آخر تحديث: 8 سبتمبر 2026 · مسوّدة عمل وليست استشارة قانونية معتمدة.</p>
<p>النسب تُحسب على المبلغ المدفوع (الخدمة + ضريبة القيمة المضافة). المهلة بأيام كاملة حسب تقويم الرياض حتى تاريخ المناسبة.</p>
<h2 style="color:#0A1A33;font-size:1.1rem">إلغاء العميل</h2>
<table border="1" cellpadding="8" style="border-collapse:collapse;width:100%;margin:1rem 0">
  <thead><tr><th>مهلة الإلغاء</th><th>يسترجع العميل</th><th>يستحق المورّد</th></tr></thead>
  <tbody>
${REFUND_TIER_ROWS}
  </tbody>
</table>
<p>يُعاد المبلغ إلى وسيلة الدفع عبر ميسر خلال 3 إلى 10 أيام عمل. المبلغ المعتمد هو ما تؤكده البوابة.</p>
<h2 style="color:#0A1A33;font-size:1.1rem">اعتذار المورّد</h2>
<p>إذا ألغى المورّد حجزًا مؤكدًا أو تخلّف عن التنفيذ، يُسترجع للعميل كامل ما تؤكده ميسر مهما قرب الموعد.</p>
<p><a href="/terms">شروط الاستخدام</a> · <a href="/support">الدعم</a></p>
`;

const TERMS_INNER = `
<p style="font-size:12px;color:#667085">مسوّدة عمل وليست استشارة قانونية معتمدة. آخر تحديث: 8 سبتمبر 2026.</p>
<p>يوصل وسيط توريد مناسبات. الأسعار تشمل ضريبة القيمة المضافة 15% ما لم يُذكر خلاف ذلك. الدفع كامل عبر ميسر عند الحجز.</p>
<p>إلغاء العميل: استرجاع كامل قبل 7 أيام أو أكثر، و50٪ من 3 أيام إلى أقل من 7، ولا استرجاع لأقل من 3 أيام. اعتذار المورّد يعيد كامل ما تؤكده ميسر. التفاصيل في <a href="/refund">سياسة الاسترجاع</a>.</p>
`;

export function staticLegalRootHtml(pathname: string): string | null {
  const path = String(pathname || '/').replace(/\/$/, '').toLowerCase() || '/';
  if (path === '/refund' || path === '/cancellation') {
    return article('سياسة الاسترجاع', REFUND_INNER);
  }
  if (path === '/terms') {
    return article('شروط الاستخدام', TERMS_INNER);
  }
  return null;
}
