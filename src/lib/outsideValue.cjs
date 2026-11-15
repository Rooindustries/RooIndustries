const PADDING = /^(?:\s|\\[nrt])+|(?:\s|\\[nrt])+$/g;
const cleanOutsideValue = (value) => (value === undefined || value === null ? "" : String(value).replace(PADDING, ""));
module.exports = { cleanOutsideValue };
