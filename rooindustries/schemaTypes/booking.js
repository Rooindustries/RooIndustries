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
    {name: 'status', title: 'Status', type: 'string'},
    {name: 'packageTitle', title: 'Package Title', type: 'string'},
    {name: 'packagePrice', title: 'Package Price', type: 'string'},
  ],
}
