echo "no key  : $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:20130/health)"
echo "with key: $(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer aarsha' http://127.0.0.1:20130/health)"
echo "models  : $(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer aarsha' http://127.0.0.1:20130/v1/models)"
echo "wrong   : $(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer nope' http://127.0.0.1:20130/health)"
echo "tailnet : $(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer aarsha' http://100.90.224.42:20130/health)"
echo "--- sample"; curl -s -H 'Authorization: Bearer aarsha' http://127.0.0.1:20130/v1/models | head -c 150; echo
