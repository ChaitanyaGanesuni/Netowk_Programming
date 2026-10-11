import { Redirect } from 'expo-router';

/**
 * Target of the backend's financeintel://oauth redirect. The auth session normally consumes
 * that URL itself; if Android delivers it as a deep link instead, return to Connections.
 */
export default function OAuthReturn() {
  return <Redirect href="/" />;
}
