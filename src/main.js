import { Viewer } from "@xeokit/xeokit-sdk";
import "../static/js/error-handler.js";
import "../static/js/upload-handler.js";
import "../static/js/design-insights.js";
import { initViewer, loadXeokitSDK } from "./xeokit_viewer.js";

window.Viewer = Viewer;
window.initViewer = initViewer;
window.loadXeokitSDK = loadXeokitSDK;
