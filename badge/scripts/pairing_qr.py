"""Small LVGL indexed QR asset. Encodes a public pairing challenge, never a token."""
import re
import struct
from urllib.parse import urlparse

def make_qr(origin, challenge):
    import qrcode
    p=urlparse(origin)
    if p.scheme!='https' or not p.netloc or p.username or p.password or p.path or p.query or p.fragment:
        raise ValueError('Expected HTTPS origin')
    if not re.fullmatch('[a-f0-9]{64}',challenge):raise ValueError('Invalid challenge')
    qr=qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M,box_size=2,border=4)
    qr.add_data(origin+'/badge#'+challenge);qr.make(fit=True)
    matrix=qr.get_matrix();size=len(matrix)*2
    if size>159:raise ValueError('Pairing QR exceeds layout')
    stride=(size+7)//8
    # LVGL v9 I1: header, two BGRA palette entries, then MSB-first indexed rows.
    data=bytearray(struct.pack('<BBHHHHH',0x19,0x07,0,size,size,stride,0))
    data.extend(bytes([255,255,255,255,0,0,0,255]))
    for y in range(size):
        row=bytearray(stride)
        for x in range(size):
            if matrix[y//2][x//2]:row[x//8]|=1<<(7-x%8)
        data.extend(row)
    return bytes(data)
