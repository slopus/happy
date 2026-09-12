package testpeer

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestBinaryEchoSizes(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(Handler))
	defer srv.Close()
	for _, size := range []int{1024, 256 * 1024, 500 * 1024} {
		for _, chunked := range []bool{false, true} {
			body := bytes.Repeat([]byte{0, 128, 255, 42}, size/4)
			r, _ := http.NewRequest("POST", srv.URL+"/echo", bytes.NewReader(body))
			if chunked {
				r.ContentLength = -1
			}
			res, err := srv.Client().Do(r)
			if err != nil {
				t.Fatal(err)
			}
			got, err := io.ReadAll(res.Body)
			res.Body.Close()
			if err != nil || res.StatusCode != 201 || !bytes.Equal(got, body) {
				t.Errorf("size=%d chunked=%v: status=%d received=%d err=%v", size, chunked, res.StatusCode, len(got), err)
			}
		}
	}
}
