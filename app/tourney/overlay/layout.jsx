export const metadata = {
  robots: {
    index: false,
    follow: false,
    nocache: true,
  },
};

export default function TourneyOverlayLayout({ children }) {
  return (
    <>
      <style>{`
        html,
        body {
          margin: 0;
          padding: 0;
          background: transparent !important;
        }
      `}</style>
      {children}
    </>
  );
}
