export default {
  name: 'booking',
  title: 'Booking',
  type: 'document',
  fields: [
    {name: 'date', title: 'Date (legacy)', type: 'string'},
    {name: 'time', title: 'Time (legacy)', type: 'string'},

    {name: 'discord', title: 'Discord Username', type: 'string'},
    {name: 'email', title: 'Email', type: 'string'},
    {name: 'specs', title: 'PC Specs', type: 'text'},
    {name: 'mainGame', title: 'Main Game', type: 'string'},
    {name: 'message', title: 'Notes', type: 'text'},

    {
      name: 'status',
      title: 'Status',
      type: 'string',
      options: {
        list: ['pending', 'captured', 'failed', 'refunded', 'completed'],
      },
      initialValue: 'pending',
    },

    {name: 'packageTitle', title: 'Package Title', type: 'string'},
    {name: 'packagePrice', title: 'Package Price', type: 'string'},

    {name: 'displayDate', title: 'Client Display Date', type: 'string'},
    {name: 'displayTime', title: 'Client Display Time', type: 'string'},
    {
      name: 'hostDate',
      title: 'Host Date',
      type: 'string',
      description: 'Date used for availability (matches host time zone).',
    },
    {
      name: 'hostTime',
      title: 'Host Time',
      type: 'string',
      description: 'Time label used to block slots, e.g. 2:00 PM.',
    },
    {name: 'hostTimeZone', title: 'Host Time Zone', type: 'string'},
    {name: 'localTimeZone', title: 'Client Time Zone', type: 'string'},
    {name: 'localTimeLabel', title: 'Client Local Time Label', type: 'string'},
    {name: 'startTimeUTC', title: 'Start Time (UTC)', type: 'datetime'},

    {name: 'referralCode', title: 'Referral Code', type: 'string'},
    {
      name: 'referral',
      title: 'Referral Creator',
      type: 'reference',
      to: [{type: 'referral'}],
    },
    {name: 'discountPercent', title: 'Discount %', type: 'number'},
    {name: 'discountAmount', title: 'Discount Amount (USD)', type: 'number'},
    {name: 'grossAmount', title: 'Gross Amount (USD)', type: 'number'},
    {name: 'netAmount', title: 'Net Amount (USD)', type: 'number'},
    {name: 'commissionPercent', title: 'Commission %', type: 'number'},
    {name: 'commissionAmount', title: 'Commission Amount (USD)', type: 'number'},

    {name: 'paymentProvider', title: 'Payment Provider', type: 'string'},
    {name: 'couponCode', title: 'Coupon Code', type: 'string'},
    {name: 'couponDiscountPercent', title: 'Coupon Discount %', type: 'number'},
    {name: 'couponDiscountAmount', title: 'Coupon Discount Amount (USD)', type: 'number'},

    {name: 'paypalOrderId', title: 'PayPal Order ID', type: 'string'},
    {name: 'payerEmail', title: 'Payer Email', type: 'string'},

    {name: 'razorpayOrderId', title: 'Razorpay Order ID', type: 'string'},
    {name: 'razorpayPaymentId', title: 'Razorpay Payment ID', type: 'string'},
  ],
}
