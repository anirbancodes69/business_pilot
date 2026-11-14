import { Logo } from '../components/icons';
import { ConfigError, loadConfig } from '../lib/config';
import { currentSession } from '../lib/server';
import { S } from '../lib/strings';
import { Chat } from './chat';

export const dynamic = 'force-dynamic';

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  let session;
  try {
    loadConfig();
    session = await currentSession();
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    return <SignIn error="config" />;
  }
  if (!session) return <SignIn error={error} />;
  return <Chat tenantName={session.tenantName} />;
}

function SignIn({ error }: { error?: string }) {
  const message = error ? S.errors[error] : undefined;
  return (
    <main id="main" className="signin">
      <section className="signin-brand">
        <div className="brand">
          <Logo size={34} />
          <span>{S.appName}</span>
        </div>
        <h1>{S.signInTitle}</h1>
        <ul>
          {S.signInPoints.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      </section>
      <section className="signin-card">
        <h2>{S.signIn}</h2>
        <p className="muted">{S.signInIntro}</p>
        {message && (
          <p role="alert" className="banner warning">
            {message}
          </p>
        )}
        <a className="button wide" href="/login">
          {S.signIn}
        </a>
      </section>
    </main>
  );
}
