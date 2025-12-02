import './style.css'
import {hydrate} from './lib/components';
import {App} from "./components/app.new";

hydrate(App({client: false}), document.querySelector('#app')!);
