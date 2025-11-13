// /sanity/schemas/booking.js
export default {
  name: 'booking',
  title: 'Booking',
  type: 'document',
  fields: [
    {name: 'date', title: 'Date', type: 'string'},
    {name: 'time', title: 'Time', type: 'string'},
    {name: 'discord', title: 'Discord Username', type: 'string'},
    {name: 'email', title: 'Email', type: 'string'},
    {name: 'specs', title: 'PC Specs', type: 'text'},
    {name: 'mainGame', title: 'Main Game', type: 'string'},
    {name: 'message', title: 'Notes', type: 'text'},
    {
      name: 'status',
      title: 'Status',
      type: 'string',
      options: {list: ['pending', 'captured', 'failed', 'refunded', 'completed']},
      initialValue: 'pending',
    },
    {name: 'packageTitle', title: 'Package Title', type: 'string'},
    {name: 'packagePrice', title: 'Package Price', type: 'string'},

    // 🔽 NEW: referral + payout
    {name: 'referralCode', title: 'Referral Code', type: 'string'},
    {
      name: 'referral',
      title: 'Referral Creator',
      type: 'reference',
      to: [{type: 'referral'}],
    },
    {name: 'discountPercent', title: 'Discount %', type: 'number'},
    {name: 'discountAmount', title: 'Discount Amount (USD)', type: 'number'},
    {name: 'grossAmount', title: 'Gross Amount (USD)', type: 'number'}, // before discount
    {name: 'netAmount', title: 'Net Amount (USD)', type: 'number'}, // after discount
    {name: 'commissionPercent', title: 'Commission %', type: 'number'},
    {name: 'commissionAmount', title: 'Commission Amount (USD)', type: 'number'},

    // 🔽 NEW: payment metadata
    {name: 'paypalOrderId', title: 'PayPal Order ID', type: 'string'},
    {name: 'payerEmail', title: 'Payer Email', type: 'string'},
  ],
}
