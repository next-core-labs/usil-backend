import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  calendarDaysUntilEvent,
  customerRefundPercent,
  previewCustomerRefundHalalas,
} from './refund-policy.ts';

/** حراسة جدول السياسة فقط — لا مسار ميسر ولا `refundBookingPayment`. */
const NOW = new Date('2026-09-08T12:00:00Z');

describe('سياسة الاسترجاع حسب قرب المناسبة', () => {
  it('7 أيام = كامل، 3 إلى أقل من 7 = نصف، أقل من 3 = صفر', () => {
    assert.equal(calendarDaysUntilEvent('2026-09-15', NOW), 7);
    assert.equal(customerRefundPercent('2026-09-15', NOW), 100);
    assert.equal(customerRefundPercent('2026-09-14', NOW), 50);
    assert.equal(customerRefundPercent('2026-09-11', NOW), 50);
    assert.equal(customerRefundPercent('2026-09-10', NOW), 0);
    assert.equal(customerRefundPercent('2026-09-08', NOW), 0);
  });

  it('معاينة الهللات لا تُكتب في دفتر الطلب — تقريب صحيح فقط', () => {
    assert.equal(previewCustomerRefundHalalas(115_000, '2026-09-15', NOW), 115_000);
    assert.equal(previewCustomerRefundHalalas(115_000, '2026-09-12', NOW), 57_500);
    assert.equal(previewCustomerRefundHalalas(115_000, '2026-09-09', NOW), 0);
  });
});
