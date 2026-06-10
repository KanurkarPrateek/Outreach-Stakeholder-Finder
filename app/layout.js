import './globals.css';

export const metadata = {
  title: 'Outreach Stakeholder Finder',
  description: 'Find senior stakeholders at a company from public search results.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
