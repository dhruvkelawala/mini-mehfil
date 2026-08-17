import { render } from 'solid-js/web';

import { App } from './App.tsx';
import './styles.css';

const root = document.querySelector<HTMLElement>('#root');
if (!root) throw new Error('The host root is missing.');
render(() => <App />, root);
