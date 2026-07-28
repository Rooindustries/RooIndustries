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
          background: transparent !important;
        }
      `}</style>
      {children}
    </>
  );
}
