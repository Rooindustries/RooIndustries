import React from "react";

export default function PrivacyPolicy() {
  return (
    <div className="max-w-3xl mx-auto p-6">
      {/* Hidden credit name */}

      <h1 className="text-3xl font-bold mb-4">Privacy Policy</h1>

      <p className="mb-4">
        At <strong>Roo Industries</strong> (rooindustries.com), your privacy is
        important to us. This Privacy Policy explains what information we
        collect, how we use it, and how you can contact us regarding your data.
      </p>

      <h2 className="text-2xl font-semibold mt-6 mb-2">
        Information We Collect
      </h2>
      <p className="mb-4">
        We may collect the following personal information from you:
      </p>
      <ul className="list-disc list-inside mb-4">
        <li>Email addresses</li>
        <li>Social media names</li>
        <li>Payment information</li>
      </ul>
      <p className="mb-4">
        We do <strong>not</strong> collect information automatically through
        cookies or similar technologies.
      </p>

      <h2 className="text-2xl font-semibold mt-6 mb-2">
        How We Use Your Information
      </h2>
      <p className="mb-4">
        We use the information we collect solely to provide customer service and
        support. We do not use your information for marketing, advertising, or
        share it with third parties at this time.
      </p>

      <h2 className="text-2xl font-semibold mt-6 mb-2">Third-Party Services</h2>
      <p className="mb-4">
        Currently, we do not use any third-party services that collect or
        process your personal data.
      </p>

      <h2 className="text-2xl font-semibold mt-6 mb-2">Your Rights</h2>
      <p className="mb-4">
        We do not currently offer deletion or modification rights for collected
        data. If you have concerns, you can contact us directly using the
        information below.
      </p>

      <h2 className="text-2xl font-semibold mt-6 mb-2">Children’s Privacy</h2>
      <p className="mb-4">
        Our website is not intended for children under the age of 13. We do not
        knowingly collect information from children.
      </p>

      <h2 className="text-2xl font-semibold mt-6 mb-2">Contact Us</h2>
      <p className="mb-4">
        If you have any questions or concerns about this Privacy Policy or your
        personal data, you can reach us at:
        <a
          href="mailto:serviroo@rooindustries.com"
          className="text-blue-600 underline"
        >
          serviroo@rooindustries.com
        </a>
      </p>

      <div className="text-blue-900 opacity-40 hover:opacity-100 transition-opacity select-text cursor-text">
        Palash Rajput
      </div>

      <p className="mt-6 text-sm text-gray-600">
        Last updated: October 16, 2025
      </p>
    </div>
  );
}
