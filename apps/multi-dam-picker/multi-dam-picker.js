import DA_SDK from 'https://da.live/nx/utils/sdk.js';
import { mountPicker } from './multi-dam-picker-render.js';

export const ready = mountPicker(document.getElementById('app'), DA_SDK);
