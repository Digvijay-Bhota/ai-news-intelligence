import { Feed } from '../components/Feed';

export default function HomePage() {
  return (
    <div className="space-y-6">
      <div className="mb-8">
        <h2 className="text-3xl font-bold text-gray-900 tracking-tight">Latest Intelligence</h2>
        <p className="mt-2 text-lg text-gray-600">Curated AI news, developments, and analysis.</p>
      </div>

      <Feed />
    </div>
  );
}
