import React from "react";
import { Link } from "react-router-dom";

export default function Terms() {
  return (
    <section className="max-w-4xl mx-auto px-6 py-28 text-white">
      <h1 className="text-3xl font-bold mb-6">Terms and Conditions</h1>

      <p className="text-white mb-6">Last Updated: October 2025</p>

      <div className="space-y-6 text-white leading-relaxed">
        <p>
          Welcome to Roo Industries. By accessing or using our website, you
          agree to comply with and be bound by these Terms and Conditions. If
          you do not agree, please do not use our services or website.
        </p>

        <h2 className="text-xl font-semibold mt-6">1. Services</h2>
        <p>
          Roo Industries provides PC optimization services aimed at improving
          device performance and functionality. We reserve the right to modify,
          suspend, or discontinue any part of the services at any time without
          prior notice.
        </p>

        <h2 className="text-xl font-semibold mt-6">2. Payments and Refunds</h2>
        <p>
          All payments for our services must be made in full at the time of
          purchase. We offer a <strong>3-day refund policy</strong> only in
          cases where we fail to perform the agreed service. Refund requests
          must be made via email at{" "}
          <a href="mailto:serviroo@rooindustries.com" className="underline">
            serviroo@rooindustries.com
          </a>{" "}
          within 3 days of the service date. Refunds are not available once the
          service has been successfully completed or partially fulfilled.
        </p>

        <h2 className="text-xl font-semibold mt-6">3. Rescheduling Policy</h2>
        <p>
          Clients may <strong>reschedule their session once for free</strong> if
          the request is made at least <strong>24 hours prior</strong> to the
          allotted time. Any subsequent reschedules will incur a{" "}
          <strong>$15 fee per session</strong> for up to two additional
          reschedules. After two paid reschedules, the session will be{" "}
          <strong>canceled automatically</strong>, and a{" "}
          <strong>70% refund of the total payment</strong> will be issued, which{" "}
          <u>does not include any previously paid rescheduling fees</u>.
        </p>

        <h2 className="text-xl font-semibold mt-6">4. User Responsibilities</h2>
        <p>
          You agree to use our services and website lawfully and responsibly.
          You may not attempt to disrupt, reverse-engineer, or misuse our
          website or services in any way.
        </p>

        <h2 className="text-xl font-semibold mt-6">
          5. Limitation of Liability
        </h2>
        <p>
          Roo Industries is not liable for any indirect, incidental, or
          consequential damages arising from the use of our website or services.
          This includes, but is not limited to, data loss, downtime, or
          performance issues that may result from PC optimization processes. You
          acknowledge that you use our services at your own risk.
        </p>

        <h2 className="text-xl font-semibold mt-6">6. Intellectual Property</h2>
        <p>
          All website content, including text, images, logos, and service names,
          is the property of Roo Industries and may not be reproduced or
          distributed without written permission.
        </p>

        <h2 className="text-xl font-semibold mt-6">7. Changes to Terms</h2>
        <p>
          We may update these Terms and Conditions from time to time. Continued
          use of our website or services after any changes constitutes your
          acceptance of the revised terms.
        </p>

        <h2 className="text-xl font-semibold mt-6">8. Contact</h2>
        <p>
          For questions or concerns about these Terms, please contact us at{" "}
          <a href="mailto:serviroo@rooindustries.com" className="underline">
            serviroo@rooindustries.com
          </a>
          .
        </p>

        <h2 className="text-xl font-semibold mt-6">9. Governing Law</h2>
        <p>
          These Terms and Conditions are governed by the laws of{" "}
          <strong>India</strong>. Any disputes shall be resolved under the
          jurisdiction of Indian courts.
        </p>

        <p className="text-sm mt-12 text-right">
          &copy; 2025 Roo Industries. All rights reserved.
        </p>
      </div>
    </section>
  );
}
