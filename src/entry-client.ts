import './style.css'
import {hydrate} from './lib/components';
import {App} from "./components/app";

hydrate(App({client: false}), document.querySelector('#app')!);
