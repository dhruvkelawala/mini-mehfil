import { render } from 'solid-js/web';

import { App } from './App.tsx';
import './styles.css';

const marker = document.querySelector<HTMLMetaElement>(
  'meta[name="mehfil-room-id"]',
);
const roomId = marker?.content ?? '';
if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(roomId)) {
  throw new Error('The listener shell does not contain a valid room code.');
}

const root = document.querySelector<HTMLElement>('#root');
if (!root) throw new Error('The listener root is missing.');
render(() => <App roomId={roomId} />, root);
