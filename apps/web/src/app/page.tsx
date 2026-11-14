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
  return (
    <>
      <header className="bar">
        <span className="brand">{S.appName}</span>
        <span className="who">
          {S.workspace}: <strong>{session.tenantName ?? '—'}</strong>
        </span>
        <form action="/logout" method="post">
          <button type="submit" className="link">
            {S.signOut}
          </button>
        </form>
      </header>
      <main id="main" className="page">
        <Chat />
      </main>
    </>
  );
}

function SignIn({ error }: { error?: string }) {
  const message = error ? S.errors[error] : undefined;
  return (
    <main id="main" className="page narrow">
      <h1>{S.appName}</h1>
      <p>{S.signInIntro}</p>
      {message && (
        <p role="alert" className="banner warning">
          {message}
        </p>
      )}
      <p>
        <a className="button" href="/login">
          {S.signIn}
        </a>
      </p>
    </main>
  );
}
