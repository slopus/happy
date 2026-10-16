# comment
variable "region" {
  type    = string
  default = "us-east-1"
}
resource "aws_instance" "web" {
  ami           = "ami-123"
  instance_type = var.size == "big" ? "t3.large" : "t3.micro"
  count         = 2
  tags = { Name = "web-${count.index}" }
}
