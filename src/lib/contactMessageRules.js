import { isValidEmail } from "./emailValidation.js";

const NAME_LIMIT = 100;
const MESSAGE_MIN = 10;
const MESSAGE_MAX = 5000;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

const text = (value) => (typeof value === "string" ? value.trim() : "");
const codePoints = (value) => Array.from(value).length;

export const contactMessageValues = ({ name, email, message }) => ({
  name: text(name).replace(/\s+/g, " "),
  email: text(email),
  message: text(message),
});

export const contactFieldErrors = ({ name, email, message }) => {
  const fields = {};
  const nameLength = codePoints(name);
  if (!nameLength || nameLength > NAME_LIMIT || CONTROL_CHARACTERS.test(name)) {
    fields.name = "Enter your name, up to 100 characters.";
  }
  if (!isValidEmail(email)) fields.email = "Enter a valid email address.";
  const messageLength = codePoints(message);
  if (messageLength < MESSAGE_MIN || messageLength > MESSAGE_MAX || CONTROL_CHARACTERS.test(message)) {
    fields.message = "Write a message between 10 and 5,000 characters.";
  }
  return fields;
};
