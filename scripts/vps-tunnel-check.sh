U=https://eyed-trio-data-affect.trycloudflare.com
echo "no key : $(curl -s -o /dev/null -w '%{http_code}' $U/health)"
echo "key    : $(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer aarsha' $U/health)"
echo "models : $(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer aarsha' $U/v1/models)"