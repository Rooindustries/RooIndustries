import { Resend } from "resend";

export default async function handler(req, res) {
  try {
    const resend = new Resend(process.env.RESEND_API_KEY);

    await resend.emails.send({
      from: "Roo Industries <bookings@updates.rooindustries.com>",
      to: "serviroo@rooindustries.com", // or your main email
      subject: "Test Email from Roo Industries",
      html: `
        <div style="font-family: Arial, sans-serif; text-align: center; padding: 20px;">
          <img src="https://rooindustries.com/embed_logo.png" alt="Roo Industries Logo" width="120" />
          <h2 style="color:#00b7c0;">This is a test email ✅</h2>
          <p>If you're seeing this, your Resend setup is working perfectly!</p>
        </div>
      `,
    });

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("Email send failed:", err);
    return res.status(500).json({ error: err.message });
  }
}
