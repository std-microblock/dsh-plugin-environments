package dsh;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.charset.Charset;

/**
 * Device-side clipboard helper for dsh-plugin-remote-environments.
 *
 * <p>It runs as the shell user through {@code app_process}, so it needs neither root nor an
 * installed APK:
 *
 * <pre>
 *   adb shell CLASSPATH=/data/local/tmp/dsh-clipboard.jar app_process / dsh.Clipboard set &lt; text
 * </pre>
 *
 * <p>Commands:
 * <ul>
 *   <li>{@code set} — read UTF-8 from stdin into the device clipboard, print {@code ok}</li>
 *   <li>{@code get} — print the device clipboard as UTF-8 on stdout (nothing when empty)</li>
 *   <li>{@code clear} — empty the device clipboard, print {@code ok}</li>
 * </ul>
 *
 * <p>Every Android type is reached through reflection, so the jar compiles with a plain JDK (no
 * android.jar) and survives signature changes across API levels.
 *
 * <p>Why it exists: {@code input text} — and scrcpy's {@code INJECT_TEXT} — turn a string into key
 * events through {@code KeyCharacterMap}, which can only produce ASCII plus a few accented Latin
 * letters; CJK and emoji are dropped. Putting the text in the clipboard and pressing
 * KEYCODE_PASTE is the only way to deliver arbitrary Unicode without installing an IME such as ADB
 * Keyboard. That is exactly what scrcpy does for Ctrl+V, minus its ~700 KiB server.
 */
public final class Clipboard {
    private static final Charset UTF8 = Charset.forName("UTF-8");
    /** The package the shell uid owns; the clipboard service checks app-ops against it. */
    private static final String SHELL_PACKAGE = "com.android.shell";

    private Clipboard() {}

    /** Forces the IClipboard binder route; used by the tests to exercise the fallback. */
    private static boolean forceBinder;

    public static void main(String[] args) {
        String command = args.length > 0 ? args[0] : "get";
        forceBinder = args.length > 1 && "binder".equals(args[1]);
        try {
            if ("set".equals(command)) {
                setText(readAll(System.in));
                System.out.println("ok");
            } else if ("clear".equals(command)) {
                clearText();
                System.out.println("ok");
            } else if ("get".equals(command)) {
                String text = getText();
                if (text != null) {
                    System.out.write(text.getBytes(UTF8));
                }
            } else {
                System.err.println("usage: Clipboard set|get|clear");
                System.exit(2);
            }
            System.out.flush();
        } catch (Throwable t) {
            System.err.println("dsh-clipboard: " + t);
            System.exit(1);
        }
    }

    private static void setText(String text) throws Exception {
        Object manager = contextClipboard();
        if (manager != null) {
            manager.getClass().getMethod("setPrimaryClip", clipDataClass()).invoke(manager, newClip(text));
            return;
        }
        Object clipboard = binderClipboard();
        Object clip = newClip(text);
        Method method = findMethod(clipboard, "setPrimaryClip", clip);
        Object[] args = method == null ? null : callArgs(method, clipDataClass(), clip);
        if (args == null) {
            throw new NoSuchMethodException("IClipboard.setPrimaryClip");
        }
        method.invoke(clipboard, args);
    }

    private static String getText() throws Exception {
        Object manager = contextClipboard();
        if (manager != null) {
            return extractText(manager.getClass().getMethod("getPrimaryClip").invoke(manager));
        }
        Object clipboard = binderClipboard();
        Method method = findMethod(clipboard, "getPrimaryClip", null);
        Object[] args = method == null ? null : callArgs(method, clipDataClass(), null);
        return args == null ? null : extractText(method.invoke(clipboard, args));
    }

    private static void clearText() throws Exception {
        Object manager = contextClipboard();
        if (manager != null) {
            manager.getClass().getMethod("clearPrimaryClip").invoke(manager);
            return;
        }
        Object clipboard = binderClipboard();
        Method method = findMethod(clipboard, "clearPrimaryClip", null);
        Object[] args = method == null ? null : callArgs(method, clipDataClass(), null);
        if (args == null) {
            throw new NoSuchMethodException("IClipboard.clearPrimaryClip");
        }
        method.invoke(clipboard, args);
    }

    /**
     * The public {@code android.content.ClipboardManager} obtained from the process' system
     * context — the route scrcpy uses through its FakeContext. The context is patched to report
     * the shell package first, otherwise the clipboard service refuses the app-op.
     *
     * @return the manager, or null when this device or API level cannot provide one
     */
    private static Object contextClipboard() {
        if (forceBinder) {
            return null;
        }
        try {
            Object context = systemContext();
            patchContext(context);
            return context.getClass().getMethod("getSystemService", String.class).invoke(context, "clipboard");
        } catch (Throwable t) {
            return null;
        }
    }

    private static Object systemContext() throws Exception {
        Class<?> activityThread = Class.forName("android.app.ActivityThread");
        Object thread = activityThread.getMethod("systemMain").invoke(null);
        return thread.getClass().getMethod("getSystemContext").invoke(thread);
    }

    /**
     * Make the context claim to be {@code com.android.shell}. Subclassing {@code ContextWrapper}
     * would be cleaner but needs android.jar at compile time, so the fields the framework reads
     * are overwritten instead. Final fields that cannot be set are simply left alone.
     */
    private static void patchContext(Object context) {
        setField(context, "mOpPackageName", SHELL_PACKAGE);
        setField(context, "mPackageName", SHELL_PACKAGE);
        // Android 12+ hands an AttributionSource to the service: rebuild it for the shell uid.
        try {
            Class<?> builderClass = Class.forName("android.content.AttributionSource$Builder");
            Object builder = builderClass.getConstructor(int.class).newInstance(myUid());
            builderClass.getMethod("setPackageName", String.class).invoke(builder, SHELL_PACKAGE);
            setField(context, "mAttributionSource", builderClass.getMethod("build").invoke(builder));
        } catch (Throwable ignored) {
            // Older devices have no AttributionSource; on newer ones the field may be final.
        }
    }

    private static void setField(Object target, String name, Object value) {
        for (Class<?> c = target.getClass(); c != null; c = c.getSuperclass()) {
            try {
                Field field = c.getDeclaredField(name);
                field.setAccessible(true);
                field.set(target, value);
                return;
            } catch (NoSuchFieldException e) {
                // keep looking up the hierarchy
            } catch (Throwable ignored) {
                return; // the field exists but refuses to be written
            }
        }
    }

    private static int myUid() {
        try {
            return (Integer) Class.forName("android.os.Process").getMethod("myUid").invoke(null);
        } catch (Throwable t) {
            return 2000; // shell
        }
    }

    private static int currentUser() {
        try {
            return (Integer) Class.forName("android.app.ActivityManager")
                    .getMethod("getCurrentUser")
                    .invoke(null);
        } catch (Throwable t) {
            return 0;
        }
    }

    private static Class<?> clipDataClass() throws ClassNotFoundException {
        return Class.forName("android.content.ClipData");
    }

    private static Object newClip(String text) throws Exception {
        return clipDataClass()
                .getMethod("newPlainText", CharSequence.class, CharSequence.class)
                .invoke(null, null, text);
    }

    private static String extractText(Object clip) throws Exception {
        if (clip == null || ((Integer) clip.getClass().getMethod("getItemCount").invoke(clip)).intValue() == 0) {
            return null;
        }
        Object item = clip.getClass().getMethod("getItemAt", int.class).invoke(clip, 0);
        Object text = item.getClass().getMethod("getText").invoke(item);
        return text == null ? null : text.toString();
    }

    // ---- fallback: the private IClipboard binder interface --------------------------------

    private static Object binderClipboard() throws Exception {
        Object binder = Class.forName("android.os.ServiceManager")
                .getMethod("getService", String.class)
                .invoke(null, "clipboard");
        if (binder == null) {
            throw new IllegalStateException("no clipboard service on this device");
        }
        return Class.forName("android.content.IClipboard$Stub")
                .getMethod("asInterface", Class.forName("android.os.IBinder"))
                .invoke(null, binder);
    }

    /** Picks the overload of {@code name} whose signature we know how to call on this API level. */
    private static Method findMethod(Object clipboard, String name, Object clip) {
        for (Method candidate : clipboard.getClass().getMethods()) {
            if (candidate.getName().equals(name) && callArgs(candidate, clipDataOrNull(), clip) != null) {
                return candidate;
            }
        }
        return null;
    }

    private static Class<?> clipDataOrNull() {
        try {
            return clipDataClass();
        } catch (ClassNotFoundException e) {
            return null;
        }
    }

    /**
     * Argument list for one IClipboard overload, or null when the signature is not one we know.
     * The AIDL interface grew parameters over the years: the ClipData (when setting), the calling
     * package, the attribution tag, then user and device ids.
     */
    private static Object[] callArgs(Method method, Class<?> clipData, Object clip) {
        Class<?>[] types = method.getParameterTypes();
        Object[] args = new Object[types.length];
        int start = 0;
        if (clipData != null && types.length > 0 && types[0] == clipData) {
            if (clip == null) {
                return null; // this overload needs a clip, but we are only reading or clearing
            }
            args[0] = clip;
            start = 1;
        } else if (clip != null) {
            return null;
        }
        int strings = 0;
        int integers = 0;
        for (int i = start; i < types.length; i++) {
            if (types[i] == String.class) {
                args[i] = strings++ == 0 ? SHELL_PACKAGE : null;
            } else if (types[i] == int.class) {
                args[i] = integers++ == 0 ? currentUser() : 0; // userId, then deviceId
            } else {
                return null;
            }
        }
        return args;
    }

    // ---- io ------------------------------------------------------------------------------

    private static String readAll(InputStream in) throws Exception {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int read;
        while ((read = in.read(chunk)) != -1) {
            buffer.write(chunk, 0, read);
        }
        return new String(buffer.toByteArray(), UTF8);
    }
}
