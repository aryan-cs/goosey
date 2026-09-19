import sys,struct,unittest
from pathlib import Path
from PIL import Image
import zxingcpp
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from pairing_qr import make_qr
class PairingQRTests(unittest.TestCase):
 def test_actual_lvgl_pixels_decode_to_public_challenge(self):
  key='abcdef0123456789'*4;origin='https://getgoosey.vercel.app';b=make_qr(origin,key)
  magic,cf,flags,w,h,stride,reserved=struct.unpack('<BBHHHHH',b[:12])
  self.assertEqual((magic,cf,flags,reserved),(25,7,0,0));self.assertEqual((w,h),(98,98));self.assertLess(len(b),1500)
  image=Image.new('RGB',(w,h),'white')
  for y in range(h):
   for x in range(w):
    if b[20+y*stride+x//8] & (1<<(7-x%8)):image.putpixel((x,y),(0,0,0))
  self.assertEqual(zxingcpp.read_barcode(image).text,origin+'/badge#'+key)
 def test_rejects_invalid_origins_and_secrets(self):
  for origin,key in [('http://example.com','a'*64),('https://u:p@example.com','a'*64),('https://example.com/path','a'*64),('https://example.com','bad')]:
   with self.assertRaises(ValueError):make_qr(origin,key)
if __name__=='__main__':unittest.main()
