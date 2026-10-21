import type { BrowserWindow } from "electron";

// Acrylic only reaches the page area of a transparent window, but Electron strips transparent
// windows of their resize frame and Windows 11's rounded corners. Cerium puts both back natively.
// Only Windows has the DLLs, so koffi loads them the first time a window needs them.

const GWL_STYLE = -16;
const WS_THICKFRAME = 0x00040000;
const SWP_FRAMECHANGED_ONLY = 0x0001 | 0x0002 | 0x0004 | 0x0020; // NOSIZE | NOMOVE | NOZORDER | FRAMECHANGED
const DWMWA_WINDOW_CORNER_PREFERENCE = 33;
const DWMWCP_ROUND = 2;

const loadWin32 = async () => {
  const { default: koffi } = await import("koffi");
  const user32 = koffi.load("user32.dll");
  const dwmapi = koffi.load("dwmapi.dll");
  return {
    getWindowLongPtr: user32.func("intptr_t __stdcall GetWindowLongPtrW(intptr_t hWnd, int nIndex)"),
    setWindowLongPtr: user32.func(
      "intptr_t __stdcall SetWindowLongPtrW(intptr_t hWnd, int nIndex, intptr_t dwNewLong)",
    ),
    setWindowPos: user32.func(
      "bool __stdcall SetWindowPos(intptr_t hWnd, intptr_t hWndInsertAfter, int X, int Y, int cx, int cy, uint32_t uFlags)",
    ),
    dwmSetWindowAttribute: dwmapi.func(
      "long __stdcall DwmSetWindowAttribute(intptr_t hwnd, uint32_t dwAttribute, _In_ int *pvAttribute, uint32_t cbAttribute)",
    ),
  };
};

let win32: ReturnType<typeof loadWin32> | undefined;

const handleOf = (window: BrowserWindow): bigint => window.getNativeWindowHandle().readBigUInt64LE();

/** Restores edge resizing, Snap and rounded corners on a transparent window. */
export const restoreNativeFrame = async (window: BrowserWindow) => {
  const { getWindowLongPtr, setWindowLongPtr, setWindowPos, dwmSetWindowAttribute } = await (win32 ??=
    loadWin32());
  if (window.isDestroyed()) return;
  const hwnd = handleOf(window);
  const style = Number(getWindowLongPtr(hwnd, GWL_STYLE));
  if ((style & WS_THICKFRAME) === 0) {
    setWindowLongPtr(hwnd, GWL_STYLE, style | WS_THICKFRAME);
    setWindowPos(hwnd, 0, 0, 0, 0, 0, SWP_FRAMECHANGED_ONLY);
  }
  dwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, [DWMWCP_ROUND], 4);
};
