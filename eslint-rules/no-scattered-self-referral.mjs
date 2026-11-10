export default {
  meta: {
    type: 'problem',
    schema: [],
    messages: {freeze: 'Keep selfReferral inside the shared booking commission freeze.'},
  },
  create(context) {
    if (context.filename.replaceAll('\\', '/').endsWith('/src/server/referrals/bookingCommission.js')) return {};
    const check = node => {
      if ((node.type === 'Identifier' ? node.name : node.value) === 'selfReferral') {
        context.report({node, messageId: 'freeze'});
      }
    };
    return {Identifier: check, Literal: check};
  },
};
