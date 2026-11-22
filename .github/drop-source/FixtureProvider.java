package test.clipboard.source;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import android.util.Log;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

public class FixtureProvider extends ContentProvider {
    private final byte[] bytes = "PR review fixture\n".getBytes(StandardCharsets.UTF_8);
    private boolean preview(Uri uri) { return "/favicon".equals(uri.getPath()); }
    private byte[] contents(Uri uri) {
        return preview(uri) ? android.util.Base64.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+kKX8AAAAASUVORK5CYII=", 0) : bytes;
    }
    public boolean onCreate() { return true; }
    public String getType(Uri uri) { return preview(uri) ? "image/png" : "application/octet-stream"; }
    public Cursor query(Uri uri, String[] cols, String selection, String[] args, String sort) {
        MatrixCursor rows = new MatrixCursor(cols);
        MatrixCursor.RowBuilder row = rows.newRow();
        for (String col : cols) {
            if (OpenableColumns.SIZE.equals(col)) row.add(contents(uri).length + (uri.getPath().equals("/short-read") ? 1 : 0));
            else if (OpenableColumns.DISPLAY_NAME.equals(col)) row.add(preview(uri) ? "favicon.png" : "PR-review-fixture.bin");
            else row.add(null);
        }
        return rows;
    }
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        Log.i("PRDropFixture", "opened=" + uri.getPath());
        File f = new File(getContext().getCacheDir(), "fixture");
        try (FileOutputStream out = new FileOutputStream(f)) { out.write(contents(uri)); }
        catch (java.io.IOException ex) { throw new FileNotFoundException(); }
        return ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY);
    }
    public Uri insert(Uri uri, ContentValues v) { throw new UnsupportedOperationException(); }
    public int update(Uri uri, ContentValues v, String s, String[] a) { throw new UnsupportedOperationException(); }
    public int delete(Uri uri, String s, String[] a) { throw new UnsupportedOperationException(); }
}
